const { VideoError } = require('../internal/errors/video-error');

class DownloadService {
  /**
   * @param {YtAudioCache} cache Cache instance
   */
  #cache;

  /**
   * @param {convertionFn} decode Function to convert the video to audio
   */
  #decode;

  /**
   * @param {redisLock.Lock} lock Redis lock instance
   */
  #lock;

  constructor(cache, decode, lock) {
    this.#cache = cache;
    this.#decode = decode;
    this.#lock = lock;
  }

  /**
   * Stream the audio of the video with the given ID
   * @param {string} id Video ID
   * @param {stream.PassThrough} pt PassThrough stream to write the audio data to
   * @param {pino.Logger} logger Logger instance
   * @returns {Promise<void>}
   */
  async streamMp3(id, pt, logger) {
    // Check if the video is already being processed
    // Lock the video ID to prevent concurrent processing
    let release;
    try {
      release = await this.#lock(`lock:${id}`);
      logger.debug('Acquired lookup lock');
      const isCached = await this.#cache.has(id);
      if (!isCached) {
        logger.info('Video is not in cache. Starting processing...');
        try {
          await this.#cache.ingestAsync(id, this.#decode, logger);
        } catch (error) {
          throw new VideoError(error);
        }
      }
    } finally {
      logger.debug('Released lookup lock');
      await release();
    }

    await this.#cache.streamAudio(id, pt, logger);
    logger.info('Finished streaming audio data');
  }
}

module.exports = { DownloadService };
