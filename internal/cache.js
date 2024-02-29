const redis = require('redis');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');

class YtAudioCache {
  /**
   * @param {redis.RedisClient} client Redis client instance
   */
  #client;

  static #emptyChunk = Buffer.from([0x00]);

  /**
   * @typedef {{targetFormat: string, targetBitrate: string, expirySecondes : number}} Options
   */

  /**
   * @param {Options} #defaultOptions
   */
  static #defaultOptions = {
    targetFormat: 'mp3',
    targetBitrate: '192k',
    expirySeconds: 4 * 3600,
  };

  /**
   * @param {Options} opt
   */
  #opt;

  /**
   *
   * @param {redis.RedisClient} client
   * @param {Partial<Options>} opt
   */
  constructor(client, opt) {
    this.#client = client;
    this.#opt = { ...YtAudioCache.#defaultOptions, ...opt };
  }

  /**
   * Returns true if the video with the given ID is in the cache
   * @param videoId
   * @returns {Promise<boolean>}
   */
  async has(videoId) {
    const res = await this.#client.exists(YtAudioCache.#streamName(videoId));
    return res === 1;
  }

  /**
   * Process the video with the given ID,
   * converting it to an MP3 audio stream and storing it in Redis
   * @param {string} videoId Video ID to process
   * @param {pino.Logger} logger Logger instance
   */
  async ingest(videoId, logger) {
    const streamName = YtAudioCache.#streamName(videoId);
    try {
      const cacheStream = new PassThrough();

      // Pipe the output of ffmpeg to the cache stream and Redis stream for the specific video
      ffmpeg(ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly' }))
        .on('error', logger.error.bind(logger))
        .toFormat(this.#opt.targetFormat)
        .audioBitrate(this.#opt.targetBitrate)
        .noVideo()
        .pipe(cacheStream);

      cacheStream.on('data', async (chunk) => {
        // Write each chunk to a Redis stream with the video ID as part of the stream name
        await this.#client.xAdd(streamName, '*', { chunk }).catch(logger.error);
      });

      cacheStream.on('end', async () => {
        logger.info('Processing finished');
        try {
          // The empty chunk will signal the end of the stream
          await this.#client.xAdd(streamName, '*', { chunk: YtAudioCache.#emptyChunk });
          await this.#client.expire(streamName, this.#opt.expirySeconds);
        } catch (error) {
          logger.error('Error adding end buffer to stream:', error);
        }
      });
    } catch (error) {
      logger.error('Error processing video; Deleting the key', error);
      await this.#client.del(streamName).catch(logger.error);
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
    const streamName = YtAudioCache.#streamName(videoId);
    const MAX_EMPTY_ITERATIONS = 10;
    let currentId = '0-0';
    let continuePolling = true;
    let emptyItCount = 0;

    while (continuePolling) {
      const res = await this.#client.xRead(redis.commandOptions({
        isolated: true,
        returnBuffers: true,
      }), [
        {
          key: streamName,
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
          logger.warn(`During polling of stream "${streamName}", max empty iterations reached. Ending polling.`);
          continuePolling = false;
          to.end();
        }
        continue;
      }

      const lastMessage = res[0].messages[res[0].messages.length - 1];
      // Look for the end buffer, which should be the only single byte null buffer
      // If found, pop it from the stream to prevent audio cracks
      if (Buffer.compare(lastMessage.message.chunk, YtAudioCache.#emptyChunk) === 0) {
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

  static #streamName(videoId) {
    return `audio_stream:${videoId}`;
  }
}

module.exports = {
  YtAudioCache,
};
