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
  const vidLengthSec = await new Promise((res, rej) => {
    ytStream.once('info', (info) => res(Number(info?.videoDetails?.lengthSeconds)));
    ytStream.once('error', rej);
  });

  logger.info('Video length: %d seconds', vidLengthSec);

  // Estimate the length of the audio stream in bytes. This won't be accurate be enough to satisfy moody browsers
  const lenEstimate = vidLengthSec * Number(opt.targetBitrate.replace('k', '000') / 8);
  to.emit('info', { contentLength: lenEstimate });

  const transcode = ffmpeg(ytStream)
    .toFormat(opt.targetFormat)
    .audioBitrate(opt.targetBitrate)
    .noVideo();

  return pipeline(transcode, to);
}

module.exports = { convert };
