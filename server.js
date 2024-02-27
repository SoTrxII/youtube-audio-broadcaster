const redis = require('redis');
const { PassThrough, Readable } = require('stream');
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('pino')({ level: 'debug' });

const expressLogger = require('pino-http')({ logger });
const sendSeekable = require('send-seekable');
const YtMp3Stream = require('./services/decode-youtube');

// Express settings

const app = express();
app.use(sendSeekable);
app.use(expressLogger);
app.set('port', process.env.PORT || 3000);

const client = redis.createClient();
client.on('connect', () => console.log('Connected to Redis...'));
client.on('error', (err) => console.error(err));
client.connect();

const CACHE_EXPIRE = 4 * 3600;

async function checkCache(req, res, next) {
  const { id } = req.params;
  try {
    const data = await client.get(redis.commandOptions({ returnBuffers: true }), id);
    if (data !== null) {
      logger.info(`Id "${id}" found in Redis cache`);
      res.setHeader('Content-type', 'audio/mpeg');
      res.setHeader('Content-length', data.length);

      const stream = new Readable();
      stream.push(data);
      stream.push(null);

      res.sendSeekable(stream, {
        length: data.length,
      });
    } else {
      logger.info(`Id "${id}" not found in Redis cache`);
      // Data not found in Redis cache, proceed to next middleware
      next();
    }
  } catch (e) {
    req.log.error(e);
    res.statusCode = 500;
    res.end('Error while trying to access cache');
  }
}
app.get('/download/mp3/:id', checkCache, async (request, response) => {
  const { id } = request.params;
  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    const infos = await ytdl.getInfo(url);

    const skipCache = infos?.videoDetails?.lengthSeconds > 3 * 3600 ?? false;
    const cacheStream = new PassThrough(); // Stream to cache data
    if (!skipCache) {
      cacheStream.on('data', (chunk) => client.append(id, chunk));
      cacheStream.on('error', async (e) => {
        request.log.error(new Error('Error with Redis ', { cause: e }));
        await client.del(id);
      });
      request.on('aborted', async () => {
        logger.info('Request aborted, deleting from cache');
        await client.del(id);
      });
      cacheStream.on('end', async () => {
        logger.info('End triggered');
        await client.expire(id, CACHE_EXPIRE);
      });
    }

    ffmpeg(ytdl(url, { filter: 'audioonly' }))
      .on('error', logger.error.bind(logger))
      .toFormat('mp3')
      .audioBitrate('192k')
      .noVideo()
      .pipe(cacheStream);
    cacheStream.pipe(response);
  } catch (e) {
    response.statusCode = 400;
    response.end("This isn't a correct Yt video link");
    logger.error(e);
  }
});

app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));
