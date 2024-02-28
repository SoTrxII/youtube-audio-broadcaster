const redis = require('redis');
const { YtAudioCache } = require('./internal/cache');
const { DownloadService } = require('./services/download.service');

const client = redis.createClient();
client.on('connect', () => console.log('Connected to Redis...'));
client.on('error', (err) => console.error(err));
client.connect();
const cache = new YtAudioCache(client);
const downloadService = new DownloadService(cache);
process.on('exit', () => {
  console.log('Exiting application. Closing Redis client...');
  client.quit(); // Close the Redis client
});

module.exports = { downloadService };
