const { strict: assert } = require('assert');
const { PassThrough } = require('stream');
const { describe, it, mock } = require('node:test');
const { DownloadService } = require('./download.service');
const { VideoError } = require('../internal/errors/video-error');

describe('DownloadService', () => {
  const logger = console;
  const lock = async () => () => {};
  const decode = () => {};

  it('streams audio for cached video', async () => {
    const cache = {
      has: mock.fn(async () => true),
      ingestAsync: mock.fn(async () => {}),
      streamAudio: mock.fn(async () => {}),
    };
    const service = new DownloadService(cache, decode, lock);
    await service.streamMp3('test', new PassThrough(), logger);
    assert.equal(cache.has.mock.callCount(), 1);
    assert.equal(cache.ingestAsync.mock.callCount(), 0);
    assert.equal(cache.streamAudio.mock.callCount(), 1);
  });

  it('ingests and streams audio for non-cached video', async () => {
    const cache = {
      has: mock.fn(async () => false),
      ingestAsync: mock.fn(async () => {}),
      streamAudio: mock.fn(async () => {}),
    };
    const service = new DownloadService(cache, decode, lock);
    await service.streamMp3('test', new PassThrough(), logger);
    assert.equal(cache.has.mock.callCount(), 1);
    assert.equal(cache.ingestAsync.mock.callCount(), 1);
    assert.equal(cache.streamAudio.mock.callCount(), 1);
  });

  it('throws VideoError when ingestAsync fails', async () => {
    const cache = {
      has: mock.fn(async () => false),
      ingestAsync: mock.fn(async () => { throw new Error('Failed to process video'); }),
      streamAudio: mock.fn(async () => {}),
    };
    const service = new DownloadService(cache, decode, lock);
    try {
      await service.streamMp3('test', new PassThrough(), logger);
      assert.fail('Expected to throw');
    } catch (err) {
      assert(err instanceof VideoError);
    }
    assert.equal(cache.has.mock.callCount(), 1);
    assert.equal(cache.ingestAsync.mock.callCount(), 1);
    assert.equal(cache.streamAudio.mock.callCount(), 0);
  });

  it('Warms up cache for non-cached video ', async () => {
    const cache = {
      has: mock.fn(async () => false),
      ingestAsync: mock.fn(async () => {}),
    };
    const service = new DownloadService(cache, decode, lock);
    await service.warmCache('test', logger);
    assert.equal(cache.has.mock.callCount(), 1);
    assert.equal(cache.ingestAsync.mock.callCount(), 1);
  });

  it('Does not warm up cache for cached video', async () => {
    const cache = {
      has: mock.fn(async () => true),
      ingestAsync: mock.fn(async () => {}),
    };
    const service = new DownloadService(cache, decode, lock);
    await service.warmCache('test', logger);
    assert.equal(cache.has.mock.callCount(), 1);
    assert.equal(cache.ingestAsync.mock.callCount(), 0);
  });
});
