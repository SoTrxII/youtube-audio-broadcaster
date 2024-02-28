const redis = require('redis');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');

const CACHE_EXPIRE = 4 * 3600;
class YtAudioCache {
  /**
   * @param {redis.RedisClient} client Redis client instance
   */
  #client;

  constructor(client) {
    this.client = client;
  }

  /**
   * Returns true if the video with the given ID is in the cache
   * @param videoId
   * @returns {Promise<boolean>}
   */
  async has(videoId) {
    const res = await this.client.exists(`audio_stream:${videoId}`);
    return res === 1;
  }

  /**
   * Process the video with the given ID,
   * converting it to an MP3 audio stream and storing it in Redis
   * @param {string} videoId Video ID to process
   * @param {pino.Logger} logger Logger instance
   */
  async ingest(videoId, logger) {
    try {
      const cacheStream = new PassThrough();

      // Pipe the output of ffmpeg to the cache stream and Redis stream for the specific video
      ffmpeg(ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly' }))
        .on('error', logger.error.bind(logger))
        .toFormat('mp3')
        .audioBitrate('192k')
        .noVideo()
        .pipe(cacheStream);

      cacheStream.on('data', async (chunk) => {
        // Write each chunk to a Redis stream with the video ID as part of the stream name
        await this.client.xAdd(`audio_stream:${videoId}`, '*', { chunk }).catch(logger.error);
      });

      cacheStream.on('end', async () => {
        logger.info('Processing finished');
        try {
          await this.client.xAdd(`audio_stream:${videoId}`, '*', { chunk: Buffer.from([0x00]) });
          await this.client.expire(`audio_stream:${videoId}`, CACHE_EXPIRE);
        } catch (error) {
          logger.error('Error adding end buffer to stream:', error);
        }
      });
    } catch (error) {
      logger.error('Error processing video; Deleting the key', error);
      await this.client.del(`audio_stream:${videoId}`);
    }
  }

  /**
   * Stream audio data from the Redis cache, continuously polling the stream for new data until the end buffer is found
   * @param {string} videoId Video ID to stream from cache
   * @param {stream.PassThrough} to PassThrough stream to pipe the audio data to
   * @param {pino.Logger} logger Logger instance
   * @returns {Promise<void>}
   */

  async streamAudio(videoId, to, logger) {
    const MAX_EMPTY_ITERATIONS = 10;
    let currentId = '0-0';
    let continuePolling = true;
    const emptyChunk = Buffer.from([0x00]);
    let emptyItCount = 0;

    while (continuePolling) {
      const res = await this.client.xRead(redis.commandOptions({
        isolated: true,
        returnBuffers: true,
      }), [
        {
          key: `audio_stream:${videoId}`,
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
          logger.warn(`During polling of stream "audio_stream:${videoId}", max empty iterations reached. Ending polling.`);
          continuePolling = false;
          to.end();
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

      for (let i = 0; i < res[0].messages.length; i++) {
        to.write(res[0].messages[i].message.chunk);
      }

      currentId = lastMessage.id;
      emptyItCount = 0;
    }
  }
}

module.exports = {
  YtAudioCache,
};
