FROM alpine:3.19 as prod
# Nodejs-current is 20.X.
RUN apk add --no-cache nodejs-current upx && upx --best --lzma /usr/bin/node && apk del upx \
    && corepack enable && corepack prepare pnpm@latest-8 --activate
COPY package.json pnpm-lock.yaml /app/
WORKDIR /app
RUN pnpm install --prod
COPY . /app
ENTRYPOINT ["node", "/app/server.js"]
