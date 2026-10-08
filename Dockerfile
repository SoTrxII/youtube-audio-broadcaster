FROM node:22-alpine
# ffmpeg: yt-dlp's mp3 extraction. python3: yt-dlp itself, as the release
# zipapp rather than the apk package, because the zipapp can update itself.
# pnpm comes from npm: corepack's bundled signing keys go stale
RUN apk add --no-cache ffmpeg python3 && npm install -g pnpm@9.15.9
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json pnpm-lock.yaml /app/
RUN pnpm install --prod --frozen-lockfile
COPY . /app
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
