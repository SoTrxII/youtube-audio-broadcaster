const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach } = require('node:test');
const { SongStore } = require('./song-store');

const DAY_MS = 24 * 3600 * 1000;
const quiet = { info() {}, warn() {}, error() {} };

async function addSong(dir, id, ageDays, size = 10) {
  const file = path.join(dir, `${id}.mp3`);
  await fs.writeFile(file, Buffer.alloc(size));
  const t = new Date(Date.now() - ageDays * DAY_MS);
  await fs.utimes(file, t, t);
}

describe('SongStore', () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'songs-'));
  });

  it('only accepts YouTube video ids', () => {
    assert.ok(SongStore.isValidId('dQw4w9WgXcQ'));
    assert.ok(SongStore.isValidId('-_aZ09-_aZ0'));
    for (const bad of ['', 'short', 'dQw4w9WgXcQx', '../../etc/pa', 'dQw4w9WgXc!', '--exec=rm -']) {
      assert.equal(SongStore.isValidId(bad), false, bad);
    }
  });

  it('reads the id out of Lullaby track ids', () => {
    assert.equal(SongStore.parseId('dQw4w9WgXcQ-'), 'dQw4w9WgXcQ');
    assert.equal(SongStore.parseId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(SongStore.parseId('abcdefghij-'), 'abcdefghij-');
    for (const bad of ['dQw4w9WgXcQx', 'dQw4w9WgXcQ--', '../../etc/pa-']) {
      assert.equal(SongStore.parseId(bad), null, bad);
    }
  });

  it('evicts songs idle for longer than maxIdleDays', async () => {
    await addSong(dir, 'old', 200);
    await addSong(dir, 'recent', 10);
    await new SongStore({ dir, maxIdleDays: 180 }).evictIdle(quiet);
    assert.deepEqual(await fs.readdir(dir), ['recent.mp3']);
  });

  it('evicts least recently used songs until enough space is free', async () => {
    await addSong(dir, 'a', 30, 100);
    await addSong(dir, 'b', 20, 100);
    await addSong(dir, 'c', 10, 100);
    // 50 free, 200 wanted: dropping the two oldest frees enough, c survives
    const store = new SongStore({ dir, minFreeBytes: 200, freeBytes: async () => 50 });
    await store.makeRoom(quiet);
    assert.deepEqual(await fs.readdir(dir), ['c.mp3']);
  });

  it('downloads a video once for concurrent requests and marks it used on later reads', async () => {
    let calls = 0;
    const download = async (id, outDir) => {
      calls += 1;
      await new Promise((r) => { setTimeout(r, 20); });
      const out = path.join(outDir, 'audio.mp3');
      await fs.writeFile(out, 'mp3');
      return out;
    };
    const store = new SongStore({ dir, download, freeBytes: async () => Infinity });
    const [p1, p2] = await Promise.all([store.get('dQw4w9WgXcQ', quiet), store.get('dQw4w9WgXcQ', quiet)]);
    assert.equal(calls, 1);
    assert.equal(p1, p2);

    const old = new Date(Date.now() - 100 * DAY_MS);
    await fs.utimes(p1, old, old);
    await store.get('dQw4w9WgXcQ', quiet);
    assert.ok((await fs.stat(p1)).mtimeMs > Date.now() - DAY_MS);
    assert.equal(calls, 1);
    // No temp dir is left behind
    assert.deepEqual(await fs.readdir(dir), ['dQw4w9WgXcQ.mp3']);
  });

  it('keeps no partial file when the download fails', async () => {
    const download = async () => {
      const err = new Error('Command failed');
      err.stderr = 'WARNING: whatever\nERROR: [youtube] dQw4w9WgXcQ: Video unavailable\n';
      throw err;
    };
    const store = new SongStore({ dir, download, freeBytes: async () => Infinity });
    await assert.rejects(store.get('dQw4w9WgXcQ', quiet), /Video unavailable/);
    assert.deepEqual(await fs.readdir(dir), []);
  });

  it('still explains a failure when yt-dlp could not start', async () => {
    const download = async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { stderr: '' }); };
    const store = new SongStore({ dir, download, freeBytes: async () => Infinity });
    await assert.rejects(store.get('dQw4w9WgXcQ', quiet), /ENOENT/);
  });
});
