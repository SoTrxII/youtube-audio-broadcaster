const logger = require('pino')({ level: 'debug' });
const redis = require('redis');
const { YtAudioCache } = require('./internal/cache');
const { DownloadService } = require('./services/download.service');

const client = redis.createClient();
client.on('connect', () => logger.info('Connected to Redis...'));
client.on('error', (err) => logger.error(err));
client.connect().catch(logger.error.bind(logger));
const cache = new YtAudioCache(client, { targetFormat: 'mp3', targetBitrate: '192k', expirySeconds: 4 * 3600 });
const downloadService = new DownloadService(cache);
process.on('exit', () => {
  logger.log('Exiting application. Closing Redis client...');
  client.quit().catch(logger.error); // Close the Redis client
});

module.exports = { downloadService };
