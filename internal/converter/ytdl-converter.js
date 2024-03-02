const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const { pipeline } = require('node:stream/promises');

/**
 * Process the video with the given ID,
 * @param {string} videoId
 * @param {stream.PassThrough} to
 * @param {pino.Logger} logger
 * @param {ConvertionOptions} opt
 */
async function convert(videoId, to, logger, opt) {
  // Ytdl stream cannot be piped directly to ffmpeg
  // with the pipeline, so errors need to be handled separately
  const ytStream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly' });
  ytStream.once('error', (error) => {
    to.emit('error', error);
  });
  const transcode = ffmpeg(ytStream)
    .toFormat(opt.targetFormat)
    .audioBitrate(opt.targetBitrate)
    .noVideo();

  return pipeline(transcode, to);
}

module.exports = { convert };
