class DownloadService {
  /**
   * @param {YtAudioCache} cache Cache instance
   */
  #cache;

  /**
   * @param {convertionFn} decode Function to convert the video to audio
   */
  #decode;

  constructor(cache, decode) {
    this.#cache = cache;
    this.#decode = decode;
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
    const isCached = await this.#cache.has(id);
    if (!isCached) {
      logger.info('"Video is not in cache. Starting processing...');
      this.#cache.ingest(id, this.#decode, logger).then((err) => {
        if (err) {
          logger.error('Error processing video:', err);
        }
      }).catch(logger.error.bind(logger));
    }

    await this.#cache.streamAudio(id, pt, logger);
    logger.info('Finished streaming audio data');
  }
}

module.exports = { DownloadService };
