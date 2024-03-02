class VideoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VideoError';
  }
}
module.exports = { VideoError };
