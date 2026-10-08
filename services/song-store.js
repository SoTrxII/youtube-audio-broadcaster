// Evictions run one file at a time on purpose: makeRoom stops as soon as enough is free
/* eslint-disable no-restricted-syntax, no-await-in-loop */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 3600 * 1000;
// Every YouTube video id is 11 chars of base64url. Checking it matters: the id
// becomes both a file name and a yt-dlp argument
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Downloads in progress live in dot-dirs, so a crash never leaves a partial
// file that looks finished, and listings skip them
const TMP_PREFIX = '.dl-';

/**
 * Download one video's audio with yt-dlp into `outDir`, returning the mp3 path.
 * yt-dlp replaced @distube/ytdl-core, which is no longer maintained and broke
 * every time YouTube changed its player. The binary self-updates at container
 * start (docker-entrypoint.sh), so a YouTube-side break needs a pod restart,
 * not a release
 */
async function ytDlp(id, outDir, { bitrate, extraArgs }) {
  await execFileAsync('yt-dlp', [
    '--no-playlist', '--no-progress',
    '-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', bitrate,
    ...extraArgs,
    '-o', path.join(outDir, 'audio.%(ext)s'),
    `https://www.youtube.com/watch?v=${id}`,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return path.join(outDir, 'audio.mp3');
}

async function statfsFree(dir) {
  const s = await fs.statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * One finished mp3 per video on disk, never a partial one.
 *
 * This replaces a Redis stream that served audio while it was still being
 * transcoded. That made players fail depending on *when* they asked: the
 * response only started once the whole stream had been replayed into memory,
 * a stall of over 1s on YouTube's side ended the body early with an estimated
 * Content-Length, and an ingest interrupted by a restart stayed cached,
 * truncated, with no TTL. A finished file served with sendFile has an exact
 * length and real Range support, which is what Safari and Firefox insist on.
 *
 * A file's mtime is its last use (atime is unreliable, often mounted noatime):
 * idle files expire after maxIdleDays, and the least recently used ones go
 * first when the disk runs short.
 */
class SongStore {
  #inFlight = new Map();

  constructor({
    dir, maxIdleDays = 180, minFreeBytes = 1024 * 1024 * 1024,
    bitrate = '192K', extraArgs = [], download = ytDlp, freeBytes = statfsFree,
  }) {
    this.dir = dir;
    this.maxIdleMs = maxIdleDays * DAY_MS;
    this.minFreeBytes = minFreeBytes;
    this.downloadOpt = { bitrate, extraArgs };
    this.download = download;
    this.freeBytes = freeBytes;
  }

  static isValidId(id) {
    return VIDEO_ID.test(id);
  }

  pathOf(id) {
    return path.join(this.dir, `${id}.mp3`);
  }

  async has(id) {
    return fs.access(this.pathOf(id)).then(() => true, () => false);
  }

  /** Path of the finished mp3, downloading it first if needed */
  async get(id, logger) {
    const file = this.pathOf(id);
    if (await this.has(id)) {
      const now = new Date();
      await fs.utimes(file, now, now).catch((e) => logger.warn(`Could not mark ${id} as used: ${e.message}`));
      return file;
    }
    // ponytail: in-process dedup, fine for the single replica. Several replicas
    // would need a shared lock, or two would download the same video
    if (!this.#inFlight.has(id)) {
      this.#inFlight.set(id, this.#fetch(id, logger).finally(() => this.#inFlight.delete(id)));
    }
    return this.#inFlight.get(id);
  }

  async #fetch(id, logger) {
    await this.makeRoom(logger);
    const tmpDir = await fs.mkdtemp(path.join(this.dir, TMP_PREFIX));
    try {
      logger.info(`Downloading ${id}`);
      const out = await this.download(id, tmpDir, this.downloadOpt);
      // Same filesystem, so the rename is atomic: readers see all of it or nothing
      await fs.rename(out, this.pathOf(id));
      logger.info(`Stored ${id}`);
      return this.pathOf(id);
    } catch (e) {
      // yt-dlp's last stderr line is its actual reason ("ERROR: Video unavailable")
      // stderr is '' (not undefined) when yt-dlp could not even start
      const reason = (String(e.stderr ?? '').trim() || e.message).split('\n').pop();
      throw new Error(reason, { cause: e });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Finished songs, least recently used first */
  async #songs() {
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.mp3') && !n.startsWith('.'));
    const songs = await Promise.all(names.map(async (n) => {
      const file = path.join(this.dir, n);
      const st = await fs.stat(file);
      return { file, mtimeMs: st.mtimeMs, size: st.size };
    }));
    return songs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  /** Delete songs nobody played for maxIdleDays */
  async evictIdle(logger, now = Date.now()) {
    for (const s of await this.#songs()) {
      if (now - s.mtimeMs <= this.maxIdleMs) break;
      logger.info(`Evicting idle ${path.basename(s.file)}`);
      await fs.rm(s.file, { force: true });
    }
  }

  /**
   * Delete the least recently used songs until minFreeBytes are free.
   * Unlinking a song being served is safe: the open stream keeps reading it
   */
  async makeRoom(logger) {
    let free = await this.freeBytes(this.dir);
    if (free >= this.minFreeBytes) return;
    for (const s of await this.#songs()) {
      logger.info(`Evicting ${path.basename(s.file)} to free space`);
      await fs.rm(s.file, { force: true });
      free += s.size;
      if (free >= this.minFreeBytes) return;
    }
    logger.warn(`Only ${free} bytes free after evicting every song`);
  }

  /** Ready the directory: no download survives a restart, so any temp dir is junk */
  async init(logger) {
    await fs.mkdir(this.dir, { recursive: true });
    for (const n of await fs.readdir(this.dir)) {
      if (n.startsWith(TMP_PREFIX)) await fs.rm(path.join(this.dir, n), { recursive: true, force: true });
    }
    await this.evictIdle(logger);
  }
}

module.exports = { SongStore };
