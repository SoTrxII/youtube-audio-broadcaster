FROM node:current-alpine
WORKDIR /app
COPY package.json /app
RUN npm install -g pm2 modclean \
    && apk add --no-cache ffmpeg git \
    && npm install --only=prod \
    && modclean -r \
    && modclean -r /usr/local/lib/node_modules/pm2 \
    && npm uninstall -g modclean \
    && npm cache clear --force \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm
EXPOSE 3000
COPY . /app
CMD pm2-runtime /app/server.js
