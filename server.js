const redis = require('redis');
const { PassThrough } = require('stream');
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('pino')({ level: 'debug' });
const { v4: uuidv4 } = require('uuid');

const expressLogger = require('pino-http')({ logger });
const sendSeekable = require('send-seekable');

// Express settings

const app = express();
app.use(sendSeekable);
app.use(expressLogger);
app.set('port', process.env.PORT || 3000);

const client = redis.createClient();
client.on('connect', () => console.log('Connected to Redis...'));
client.on('error', (err) => console.error(err));
client.connect();
process.on('exit', () => {
  console.log('Exiting application. Closing Redis client...');
  client.quit(); // Close the Redis client
});

const CACHE_EXPIRE = 4 * 3600;
app.get('/download/mp3/:id', async (request, response) => {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    // Check if the video is already being processed
    const isCached = await client.exists(`audio_stream:${id}`);
    if (isCached === 0) {
      subLogger.info('"Video is not in cache. Starting processing...');
      processVideo(id, subLogger).catch(subLogger.error.bind(subLogger));
    }

    response.setHeader('Content-Type', 'audio/mpeg');
    const pt = new PassThrough();
    pt.pipe(response);
    await streamFromCache(id, pt, subLogger);
    subLogger.info('Finished streaming audio data');
  } catch (error) {
    response.status(500).send('Error streaming audio data');
    subLogger.error('Error streaming audio data:', error);
  }
});

/**
 * Stream audio data from the Redis cache, continuously polling the stream for new data until the end buffer is found
 * @param {string} id Video ID to stream from cache
 * @param {stream.PassThrough} pt PassThrough stream to pipe the audio data to
 * @param {pino.Logger} logger Logger instance
 * @returns {Promise<void>}
 */
async function streamFromCache(id, pt, logger) {
  const MAX_EMPTY_ITERATIONS = 10;
  let currentId = '0-0';
  let continuePolling = true;
  const emptyChunk = Buffer.from([0x00]);
  let emptyItCount = 0;

  while (continuePolling) {
    const res = await client.xRead(redis.commandOptions({
      isolated: true,
      returnBuffers: true,
    }), [
      {
        key: `audio_stream:${id}`,
        id: currentId,
      },
    ], {
      // block for 0.1 seconds if there are no new messages
      BLOCK: 100,
    });

    // Prevent empty iterations from running indefinitely, which could happen if the stream is empty
    if (!res || res.length === 0 || res[0].messages.length === 0) {
      emptyItCount++;
      if (emptyItCount > MAX_EMPTY_ITERATIONS) {
        logger.warn(`During polling of stream "audio_stream:${id}", max empty iterations reached. Ending polling.`);
        continuePolling = false;
        pt.end();
      }
      continue;
    }

    const lastMessage = res[0].messages[res[0].messages.length - 1];
    // Look for the end buffer, which should be the only single byte null buffer
    // If found, pop it from the stream to prevent audio cracks
    if (Buffer.compare(lastMessage.message.chunk, emptyChunk) === 0) {
      continuePolling = false;
      res[0].messages.pop();
    }

    for (const msg of res[0].messages) {
      pt.write(msg.message.chunk);
    }

    currentId = lastMessage.id;
    emptyItCount = 0;
  }
}

/**
 * Process the video with the given ID, converting it to an MP3 audio stream and storing it in Redis
 * @param {string} id Video ID to process
 * @param {pino.Logger} logger Logger instance
 */
async function processVideo(id, logger) {
  try {
    const cacheStream = new PassThrough();

    // Pipe the output of ffmpeg to the cache stream and Redis stream for the specific video
    ffmpeg(ytdl(`https://www.youtube.com/watch?v=${id}`, { filter: 'audioonly' }))
      .on('error', logger.error.bind(logger))
      .toFormat('mp3')
      .audioBitrate('192k')
      .noVideo()
      .pipe(cacheStream);

    cacheStream.on('data', async (chunk) => {
      // Write each chunk to a Redis stream with the video ID as part of the stream name
      await client.xAdd(`audio_stream:${id}`, '*', { chunk }).catch(logger.error);
    });

    cacheStream.on('end', async () => {
      logger.info('Processing finished');
      try {
        await client.xAdd(`audio_stream:${id}`, '*', { chunk: Buffer.from([0x00]) });
        await client.expire(`audio_stream:${id}`, CACHE_EXPIRE);
      } catch (error) {
        logger.error('Error adding end buffer to stream:', error);
      }
      // Optionally, you can perform cleanup tasks here
    });
  } catch (error) {
    logger.error('Error processing video:', error);
  }
}

app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));
