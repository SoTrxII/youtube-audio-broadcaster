const redis = require('redis');
const { PassThrough } = require('stream');

class YtAudioCache {
  /**
   * @param {redis.Client} client Redis client instance
   */
  #client;

  static emptyChunk = Buffer.from([0x00]);

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
   * @param {redis.Client} client
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
   * Starts processing the video with the given ID,
   * converting it to an MP3 audio stream and storing it in Redis
   * This methods resolves when the first chunk of audio data is received
   * from the decoder or rejects if an error occurs
   * @param {string} videoId Video ID to process
   * @param {convertionFn} decode Function to convert the video to audio
   * @param {pino.Logger} logger Logger instance
   */
  async ingestAsync(videoId, decode, logger) {
    return new Promise((res, rej) => {
      const cacheStream = new PassThrough();
      cacheStream.once('data', res);
      this.ingestWorker(videoId, cacheStream, decode, logger).catch(rej);
    });
  }

  /**
   * Process the video with the given ID, converting it to an MP3 audio stream
   * @param videoId
   * @param cacheStream
   * @param decode
   * @param logger
   */
  async ingestWorker(videoId, cacheStream, decode, logger) {
    const streamName = YtAudioCache.#streamName(videoId);

    let totalBytes = 0;
    cacheStream.on('data', async (chunk) => {
      await this.#client.xAdd(streamName, '*', { chunk }).catch(logger.error);
      totalBytes += chunk.length;
    });

    cacheStream.on('end', async () => {
      logger.info('Processing finished');
      try {
        // The empty chunk will signal the end of the stream
        await this.#client.xAdd(streamName, '*', { chunk: YtAudioCache.emptyChunk, totalSize: String(totalBytes) });
        await this.#client.expire(streamName, this.#opt.expirySeconds);
      } catch (error) {
        logger.error('Error adding end buffer to stream %o:', error);
      }
    });

    // Decode the video and pipe the audio data to the cache stream
    try {
      await decode(videoId, cacheStream, logger, this.#opt);
    } catch (e) {
      await this.#client.del(streamName);
      throw new Error(`Decoding failed for video ${videoId}`, { cause: e });
    }
  }

  /**
   * Get the length of the audio stream in bytes
   * @param videoId
   * @returns {Promise<number>}
   */
  async getAudioLength(videoId, logger) {
    const streamName = YtAudioCache.#streamName(videoId);
    // const res = await this.#client.xRevRange(streamName, '+', '-', 'COUNT', 1);
    try {
      const res = await this.#client.xRevRange(streamName, '+', '-', {
        BLOCK: 100,
        COUNT: 1,
      });
      if (!res || res.length === 0 || !res[0].message?.totalSize) {
        return undefined;
      }
      return Number(res[0].message?.totalSize);
    } catch (e) {
      logger.warn(`Error getting audio length: ${e.message}`);
      return undefined;
    }
  }

  /**
   * Stream audio data from the Redis cache,
   * continuously polling the stream for new data until the end buffer is found
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
      // eslint-disable-next-line no-await-in-loop
      const res = await this.#client.xRead(redis.commandOptions({
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

      // Prevent empty iterations from running indefinitely,
      // which could happen if the end buffer is not found
      if (!res || res.length === 0 || res[0].messages.length === 0) {
        emptyItCount += 1;
        if (emptyItCount > MAX_EMPTY_ITERATIONS) {
          logger.warn(`During polling of stream "${streamName}", max empty iterations reached. Ending polling.`);
          continuePolling = false;
          to.end();
        }
        // eslint-disable-next-line no-continue
        continue;
      }

      const lastMessage = res[0].messages[res[0].messages.length - 1];
      // Look for the end buffer, which should be the only single byte null buffer
      // If found, pop it from the stream to prevent audio cracks
      if (Buffer.compare(lastMessage.message.chunk, YtAudioCache.emptyChunk) === 0) {
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
