require('dotenv').config();
const logger = require('pino')({ level: process.env.LOG_LEVEL ?? 'info' });
const expressLogger = require('pino-http')({ logger });
const express = require('express');
const { SongStore } = require('./services/song-store');

const DAY_MS = 24 * 3600 * 1000;

const store = new SongStore({
  dir: process.env.CACHE_DIR ?? '/data',
  maxIdleDays: Number(process.env.MAX_IDLE_DAYS ?? 180),
  // A song is 3-10 MB at 192k; 1 GiB of headroom keeps a whole evening's
  // worth of new songs from ever filling the volume mid-session
  minFreeBytes: Number(process.env.MIN_FREE_MB ?? 1024) * 1024 * 1024,
  bitrate: process.env.AUDIO_BITRATE ?? '192K',
  // The knob for YouTube's next change (cookies, extractor args...).
  // yt-dlp only enables deno by default to solve YouTube's JS challenges;
  // node is what this image ships
  extraArgs: (process.env.YTDLP_ARGS ?? '--js-runtimes node').split(/\s+/).filter(Boolean),
});

const app = express();
app.use(expressLogger);
app.set('port', process.env.APP_PORT || 3000);

/** Reject anything that isn't a video id before it reaches the disk or yt-dlp */
function withId(handler) {
  return async (req, res) => {
    const id = SongStore.parseId(req.params.id);
    if (!id) {
      res.status(400).send('Invalid video id');
      return;
    }
    try {
      await handler(req, res, id);
    } catch (error) {
      req.log.error(`${id}: ${error.message}`);
      // Lullaby shows this text as the warmup button's tooltip
      res.status(502).type('text').send(error.message);
    }
  };
}

// Both paths are in use: /download/mp3 by Lullaby's jukebox, /stream by its search preview
app.get(['/download/mp3/:id', '/stream/:id'], withId(async (req, res, id) => {
  // sendFile answers Range requests with 206 and an exact Content-Length
  res.sendFile(await store.get(id, req.log));
}));

app.get('/warmup/:id', withId(async (req, res, id) => {
  await store.get(id, req.log);
  res.status(200).send('Warmup successful');
}));

app.get('/has/:id', withId(async (req, res, id) => {
  res.status(200).send({ cached: await store.has(id) });
}));

// A failed init (volume not writable) rejects unhandled and crashes the pod, which is the point
store.init(logger).then(() => {
  setInterval(() => store.evictIdle(logger).catch((e) => logger.error(e)), DAY_MS).unref();
});

app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));
