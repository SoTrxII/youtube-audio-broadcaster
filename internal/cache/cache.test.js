const { describe, test, mock } = require('node:test');
const assert = require('node:assert').strict;

const { PassThrough } = require('stream');
const { YtAudioCache } = require('./cache');

describe('YtAudioCache', () => {
  const logger = console;

  describe('ingest', (t) => {
    test('Decode error', async () => {
      const delMock = mock.fn(async () => { });
      const fakeRedis = {
        xAdd: mock.fn(() => { }),
        expires: mock.fn(() => { }),
        del: delMock,
      };
      const cache = new YtAudioCache(fakeRedis, {}, logger);
      const decode = mock.fn(() => { throw new Error('Failed to process video'); });
      try {
        await cache.ingestWorker('test', new PassThrough(), decode, logger);
        t.fail();
      } catch (err) {
        assert.equal(err.message, 'Decoding failed for video test');
        assert.equal(delMock.mock.calls.length, 1);
        assert.equal(delMock.mock.calls.length, 1);
      }
    });

    test('returns error when processing fails', async (t) => {
      const delMock = mock.fn(async () => { });
      const fakeRedis = {
        xAdd: mock.fn(() => { throw new Error('Failed to process video'); }),
        expires: mock.fn(() => { }),
        del: delMock,
      };
      const cache = new YtAudioCache(fakeRedis, {}, logger);
      const decode = mock.fn(() => { throw new Error('Failed to process video'); });
      try {
        await cache.ingestWorker('test', new PassThrough(), decode, logger);
        t.fail();
      } catch (err) {
        assert.equal(err.message, 'Decoding failed for video test');
        assert.equal(delMock.mock.calls.length, 1);
        assert.equal(delMock.mock.calls.length, 1);
      }
    });
  });
  describe('streamAudio', () => {
    test('ends polling and stream when max empty iterations reached', async () => {
      const fakeRedis = {
        xRead: mock.fn(() => []),
      };
      const cache = new YtAudioCache(fakeRedis, {}, logger);

      const to = new PassThrough();
      await cache.streamAudio('test', to, logger);
    });

    test('writes data to stream when data is available, ends when encountering null byte', async () => {
      const fakeRedis = {
        xRead: mock.fn(() => [{
          messages: [
            { id: 'stream', message: { chunk: Buffer.from('data') } },
            { id: 'stream', message: { chunk: YtAudioCache.emptyChunk } },
          ],
        }]),
      };
      const cache = new YtAudioCache(fakeRedis, {}, logger);
      const to = new PassThrough();
      await cache.streamAudio('test', to, logger);
      const data = to.read();
      assert.equal(data.toString(), 'data');
    });
  });
});
