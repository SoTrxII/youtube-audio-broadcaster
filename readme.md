 # Youtube audio broadcaster
 
Serves the audio of a YouTube video as an mp3, so every player of a Roll20 game
can play the same track from the jukebox.

## How it works

The first request for a video downloads it with [yt-dlp](https://github.com/yt-dlp/yt-dlp)
and stores the finished mp3 on disk. Every later request is served from that file,
with an exact `Content-Length` and HTTP Range support (206), which strict browsers
(Safari, Firefox) need to play it at all. A video is downloaded once even if several
players ask for it at the same time.

The first play of a video waits for the whole download. Warm it up beforehand
(`/warmup/:id`, the warmup button in Lullaby) to avoid that.

yt-dlp updates itself when the container starts, so when YouTube breaks extraction,
restarting the pod is usually enough.

### Eviction

A file's modification time is its last use, refreshed on every play.
- Songs unused for `MAX_IDLE_DAYS` are deleted (checked at start, then daily).
- Before a download, if less than `MIN_FREE_MB` is free or the songs take more
  than `MAX_CACHE_MB`, the least recently used ones are deleted until neither holds.
  Set `MAX_CACHE_MB` when the volume does not enforce its size (k3s `local-path`
  shows the whole node disk), otherwise only the node filling up triggers this.

## Configuration

| Variable        | Description                                                  | Default              |
|-----------------|--------------------------------------------------------------|----------------------|
| `APP_PORT`      | The port the server listens on                               | `3000`               |
| `CACHE_DIR`     | Where finished mp3s are stored (mount a volume here)         | `/data`              |
| `MAX_IDLE_DAYS` | Delete songs not played for this many days                   | `180`                |
| `MIN_FREE_MB`   | Free space to keep on the volume before a download           | `1024`               |
| `MAX_CACHE_MB`  | Total size of the songs to stay under (unset: no cap)        | unset                |
| `AUDIO_BITRATE` | mp3 quality given to yt-dlp                                  | `192K`               |
| `YTDLP_ARGS`    | Extra yt-dlp arguments (cookies, extractor args...)          | `--js-runtimes node` |

## Usage

| Endpoint                            | Description                                          |
|-------------------------------------|------------------------------------------------------|
| `GET /download/mp3/:id`, `/stream/:id` | The mp3 (both kept for Lullaby)                   |
| `GET /warmup/:id`                   | Download it now; returns once the file is complete   |
| `GET /has/:id`                      | `{"cached": true}` once the file is complete         |

`:id` must be an 11-character YouTube video id. On failure the body is yt-dlp's
reason (e.g. `ERROR: ... Video unavailable`), which Lullaby shows as a tooltip.
