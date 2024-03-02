const { strict: assert } = require('assert');
const { PassThrough } = require('stream');
const {
  describe, it, before, after,
} = require('node:test');
const redis = require('redis');
const redisLock = require('redis-lock');
const { DownloadService } = require('./download.service');
const { YtAudioCache } = require('../internal/cache/cache');
const { convert } = require('../internal/converter/ytdl-converter');

describe('DownloadService :: Integration', () => {
  let client;
  let lock;
  const logger = console;

  before(() => {
    client = redis.createClient();
    client.on('connect', () => logger.info('Connected to Redis...'));
    client.on('error', (err) => logger.error(err));
    client.connect().catch(logger.error.bind(logger));
    lock = redisLock(client);
  });

  it('Only processes video once', async (t) => {
    const cache = new YtAudioCache(client, { targetFormat: 'mp3', targetBitrate: '192k', expirySeconds: 3 });
    t.mock.method(cache, 'ingestAsync');
    t.mock.method(cache, 'streamAudio');
    t.mock.method(cache, 'has');

    const service = new DownloadService(cache, convert, lock);
    await Promise.all([
      service.streamMp3('FKLtgamrhpk', new PassThrough(), logger),
      service.streamMp3('FKLtgamrhpk', new PassThrough(), logger),
    ]);
    assert.equal(cache.ingestAsync.mock.callCount(), 1);
    assert.equal(cache.streamAudio.mock.callCount(), 2);
    assert.equal(cache.has.mock.callCount(), 2);
  });

  after(() => {
    client.quit().catch(logger.error.bind(logger)); // Close the Redis client
  });
});
