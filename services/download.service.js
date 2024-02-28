class DownloadService {
  /**
   * @param {YtAudioCache} cache Cache instance
   */
  #cache;

  constructor(cache) {
    this.#cache = cache;
  }

  async streamMp3(id, pt, logger) {
    // Check if the video is already being processed
    const isCached = await this.#cache.has(id);
    if (!isCached) {
      logger.info('"Video is not in cache. Starting processing...');
      this.#cache.ingest(id, logger).catch(logger.error.bind(logger));
    }

    await this.#cache.streamAudio(id, pt, logger);
    logger.info('Finished streaming audio data');
  }
}

module.exports = { DownloadService };
