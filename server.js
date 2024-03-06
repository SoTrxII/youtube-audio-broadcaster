const { PassThrough } = require('stream');
const logger = require('pino')({ level: 'debug' });
const expressLogger = require('pino-http')({ logger });
const express = require('express');
const parseRange = require('range-parser');
const { v4: uuidv4 } = require('uuid');
const { downloadService, redis } = require('./dependency-injection');
const { VideoError } = require('./internal/errors/video-error');
require('dotenv').config();

const app = express();
app.use(expressLogger);
app.set('port', process.env.APP_PORT || 3000);

app.get('/download/mp3/:id', handleSong);
app.get('/stream/:id', handleSong);

async function handleSong(request, response) {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    response.setHeader('Content-Type', 'audio/mpeg');
    response.setHeader('Accept-Ranges', 'bytes');
    const to = new PassThrough();

    // If the request has a range header,
    // use Chunked transfer encoding to stream the requested range
    if (request.headers.range) {
      // The range request needs the total length of the audio file
      // This won't be available in the cache if the video is not already processed
      // so we use a default value
      const totalBytes = await downloadService.getAudioLength(id, subLogger) ?? 5E8;
      logger.debug('Total bytes: %d', totalBytes);

      const ranges = parseRange(totalBytes, request.headers.range);
      if (ranges === -1) {
        response.status(416).send('Range Not Satisfiable');
        return;
      }
      const { start, end } = ranges[0];

      response.setHeader('Transfer-Encoding', 'chunked');
      response.status(206);
      response.write('\r\n');

      to.on('data', (chunk) => {
        const chunkStart = 0;
        const chunkEnd = chunkStart + chunk.length - 1;

        if (chunkEnd >= start && chunkStart <= end) {
          const offset = Math.max(0, start - chunkStart);
          const length = Math.min(chunk.length - offset, end - start + 1);
          response.write(chunk.slice(offset, offset + length));
        }
      });

      await downloadService.streamMp3(id, to, subLogger);
      response.end('\r\n');
    } else {
      // If the request does not have a range header, stream the entire audio file
      response.status(200);
      await downloadService.streamMp3(id, response, subLogger);
    }
  } catch (error) {
    response.setHeader('Content-type', 'application/text');
    subLogger.error(`Error in request: ${error.message}`, { error });
    if (error instanceof VideoError) {
      response.status(404).send('Video not found');
      return;
    }
    response.status(500).send('Error streaming audio data');
  }
}

const server = app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));

server.on('close', () => {
  logger.info('Exiting application. Closing web server && redis connection...');
  redis.quit().catch(logger.error.bind(logger)); // Close the Redis client
});

module.exports = {
  server,
};
