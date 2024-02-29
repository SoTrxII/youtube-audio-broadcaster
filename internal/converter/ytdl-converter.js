const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');

/**
 * Process the video with the given ID,
 * @param {string} videoId
 * @param {stream.PassThrough} to
 * @param {pino.Logger} logger
 * @param {ConvertionOptions} opt
 */
function convert(videoId, to, logger, opt) {
  ffmpeg(ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly' }))
    .on('error', logger.error.bind(logger))
    .toFormat(opt.targetFormat)
    .audioBitrate(opt.targetBitrate)
    .noVideo()
    .pipe(to);
}

module.exports = { convert };
