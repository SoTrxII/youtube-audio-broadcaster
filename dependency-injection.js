const logger = require('pino')({ level: 'debug' });
const redis = require('redis');
const redisLock = require('redis-lock');
const { YtAudioCache } = require('./internal/cache/cache');
const { DownloadService } = require('./services/download.service');
const { convert } = require('./internal/converter/ytdl-converter');
/**
 * @typedef {import('pino')} pino
 * @typedef {{targetFormat: string, targetBitrate: string}} ConvertionOptions
 * @typedef {ConvertionOptions & {expirySecondes : number}} Options
 * @typedef {(videoId: string, to: stream.PassThrough, logger: Logger, opt: ConvertionOptions ) => void} convertionFn
 */

const client = redis.createClient();
client.on('connect', () => logger.info('Connected to Redis...'));
client.on('error', (err) => logger.error(err));
client.connect().catch(logger.error.bind(logger));
const lock = redisLock(client);
const cache = new YtAudioCache(client, { targetFormat: 'mp3', targetBitrate: '192k', expirySeconds: 4 * 3600 });
const downloadService = new DownloadService(cache, convert, lock);
process.on('SIGINT', () => {
  logger.info('Exiting application. Closing Redis client...');
  client.quit().catch(logger.error.bind(logger)); // Close the Redis client
  process.exit(-1);
});

module.exports = { downloadService };
