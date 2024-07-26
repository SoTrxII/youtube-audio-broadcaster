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
  const testIds = [
    'FKLtgamrhpk',
    'J6Eo4oKsQEY',
  ];

  before(() => {
    client = redis.createClient({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: process.env.REDIS_PORT ?? 6379,
      password: process.env.REDIS_PASSWORD ?? undefined,
    });
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
      service.streamMp3(testIds[0], new PassThrough(), logger),
      service.streamMp3(testIds[0], new PassThrough(), logger),
    ]);
    assert.equal(cache.ingestAsync.mock.callCount(), 1);
    assert.equal(cache.streamAudio.mock.callCount(), 2);
    assert.equal(cache.has.mock.callCount(), 2);
  });

  it('Correctly state the cache status of a video pre and post warmup', async (t) => {
    const cache = new YtAudioCache(client, { targetFormat: 'mp3', targetBitrate: '192k', expirySeconds: 3 });
    t.mock.method(cache, 'ingestAsync');
    t.mock.method(cache, 'streamAudio');
    t.mock.method(cache, 'has');

    const service = new DownloadService(cache, convert, lock);
    assert.equal(await cache.has(testIds[1]), false);
    await service.warmCache(testIds[1], logger);
    assert.equal(await cache.has(testIds[1]), true);
  });

  after(() => {
    // Clean up the cache
    for (let i = 0; i < testIds.length; i += 1) {
      client.del(`audio_stream:${testIds[i]}`).catch(logger.error.bind(logger));
    }

    client.quit().catch(logger.error.bind(logger)); // Close the Redis client
  });
});
