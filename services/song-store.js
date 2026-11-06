// Evictions run one file at a time on purpose: makeRoom stops as soon as enough is free
/* eslint-disable no-restricted-syntax, no-await-in-loop */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 3600 * 1000;
// yt-dlp -U asks GitHub for the latest release: once an hour is plenty, and it
// bounds the cost of videos that fail for good ("Video unavailable")
const UPDATE_EVERY_MS = 3600 * 1000;
// Up since 2009 and playable everywhere: if it fails, every download does
const PROBE_ID = 'dQw4w9WgXcQ';
// Every YouTube video id is 11 chars of base64url. Checking it matters: the id
// becomes both a file name and a yt-dlp argument
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Downloads in progress live in dot-dirs, so a crash never leaves a partial
// file that looks finished, and listings skip them
const TMP_PREFIX = '.dl-';

/**
 * Download one video's audio with yt-dlp into `outDir`, returning the mp3 path.
 * yt-dlp replaced @distube/ytdl-core, which is no longer maintained and broke
 * every time YouTube changed its player. The binary updates itself (SongStore's
 * selfUpdate), so a YouTube-side break needs neither a release nor a restart
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

/**
 * Update the yt-dlp zipapp in place, returning its version before and after.
 * Updating only at container start was not enough: a pod up since 2026-10-08
 * still ran 2026.08.19 on 2026-11-05, two releases behind
 */
async function ytDlpUpdate() {
  const version = async () => (await execFileAsync('yt-dlp', ['--version'])).stdout.trim();
  const before = await version();
  await execFileAsync('yt-dlp', ['-U']);
  return { before, after: await version() };
}

/** Resolve one known video, downloading nothing, with the same cookies and proxy */
async function ytDlpProbe(extraArgs) {
  await execFileAsync('yt-dlp', [
    '--simulate', '--no-playlist', '-f', 'bestaudio', ...extraArgs,
    `https://www.youtube.com/watch?v=${PROBE_ID}`,
  ]);
}

/**
 * yt-dlp's last stderr line is its actual reason ("ERROR: Video unavailable").
 * stderr is '' (not undefined) when yt-dlp could not even start
 */
function reasonOf(e) {
  return (String(e.stderr ?? '').trim() || e.message).split('\n').pop();
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
 * first when the disk runs short or the songs outgrow maxBytes.
 */
class SongStore {
  #inFlight = new Map();

  #lastUpdate = -Infinity;

  constructor({
    dir, maxIdleDays = 180, minFreeBytes = 1024 * 1024 * 1024, maxBytes = Infinity,
    bitrate = '192K', extraArgs = [], download = ytDlp, freeBytes = statfsFree,
    update = ytDlpUpdate, probe = ytDlpProbe,
  }) {
    this.dir = dir;
    this.maxIdleMs = maxIdleDays * DAY_MS;
    this.minFreeBytes = minFreeBytes;
    this.maxBytes = maxBytes;
    this.downloadOpt = { bitrate, extraArgs };
    this.download = download;
    this.freeBytes = freeBytes;
    this.update = update;
    this.probe = probe;
  }

  static isValidId(id) {
    return VIDEO_ID.test(id);
  }

  /**
   * The video id in a request path, or null. Lullaby names its tracks the
   * Roll20 way, `<file>-<suffix>` with an empty suffix, so every call it makes
   * ends in `<id>-`: 2.0.0 refused them all with 400 and nothing played
   */
  static parseId(param) {
    const id = param.length === 12 && param.endsWith('-') ? param.slice(0, 11) : param;
    return SongStore.isValidId(id) ? id : null;
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
      let out;
      try {
        out = await this.download(id, tmpDir, this.downloadOpt);
      } catch (e) {
        // YouTube breaks yt-dlp every few weeks and a fixed release follows
        // within days: the first failure after one is when to fetch it
        if (!await this.selfUpdate(logger)) throw e;
        logger.warn(`${id}: retrying after a yt-dlp update`);
        out = await this.download(id, tmpDir, this.downloadOpt);
      }
      // Same filesystem, so the rename is atomic: readers see all of it or nothing
      await fs.rename(out, this.pathOf(id));
      logger.info(`Stored ${id}`);
      return this.pathOf(id);
    } catch (e) {
      throw new Error(reasonOf(e), { cause: e });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Update yt-dlp, at most once per UPDATE_EVERY_MS. True only when the
   * version changed, i.e. when retrying a failed download can help
   */
  async selfUpdate(logger, now = Date.now()) {
    if (now - this.#lastUpdate < UPDATE_EVERY_MS) return false;
    // Set before awaiting, so concurrent failures trigger a single update
    this.#lastUpdate = now;
    try {
      const { before, after } = await this.update();
      if (before === after) return false;
      logger.info(`yt-dlp updated from ${before} to ${after}`);
      return true;
    } catch (e) {
      logger.warn(`yt-dlp self-update failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Expired cookies or a bot wall otherwise show only when someone asks for a
   * song not on disk, possibly mid-session. Logged as an error, so the
   * "YouTube download failed" alert fires the day it happens
   */
  async check(logger) {
    try {
      await this.probe(this.downloadOpt.extraArgs);
      logger.info('YouTube check passed');
    } catch (e) {
      logger.error(`YouTube check failed: ${reasonOf(e)}`);
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
   * Delete the least recently used songs until minFreeBytes are free and the
   * songs fit in maxBytes. Free space alone is not a cap: the volume's
   * requested size is not enforced by k3s' local-path, so statfs reports the
   * whole node disk (measured 2026-10-08: 290 GB seen from a "5Gi" volume).
   * Runs before a download, so the total can exceed maxBytes by that one song.
   * Unlinking a song being served is safe: the open stream keeps reading it
   */
  async makeRoom(logger) {
    let free = await this.freeBytes(this.dir);
    const songs = await this.#songs();
    let used = songs.reduce((sum, s) => sum + s.size, 0);
    for (const s of songs) {
      if (free >= this.minFreeBytes && used <= this.maxBytes) return;
      logger.info(`Evicting ${path.basename(s.file)} to free space`);
      await fs.rm(s.file, { force: true });
      free += s.size;
      used -= s.size;
    }
    if (free < this.minFreeBytes) logger.warn(`Only ${free} bytes free after evicting every song`);
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
