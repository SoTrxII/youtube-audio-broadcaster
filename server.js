const { PassThrough } = require('stream');
const logger = require('pino')({ level: 'debug' });
const expressLogger = require('pino-http')({ logger });
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const sendSeekable = require('send-seekable');
const { downloadService, redis } = require('./dependency-injection');
const { VideoError } = require('./internal/errors/video-error');
require('dotenv').config();

const app = express();
app.use(expressLogger);
app.use(sendSeekable);
app.set('port', process.env.APP_PORT || 3000);

app.get('/download/mp3/:id', handleSong);
app.get('/stream/:id', handleSong);
app.get('/warmup/:id', warmup);
app.get('/has/:id', has);

async function handleSong(request, response) {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    response.setHeader('Content-Type', 'audio/mpeg');
    response.setHeader('Accept-Ranges', 'bytes');
    logger.info('Requesting audio for video: %s from user agent', id, request.headers['Sec-Ch-Ua']);
    const to = new PassThrough();
    await downloadService.streamMp3(id, to, subLogger);
    const totalBytes = await downloadService.getAudioLength(id, subLogger);
    logger.info('Total bytes: %d', totalBytes);
    response.sendSeekable(to, { length: totalBytes, type: 'audio/mpeg' });
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

// Add warmup endpoint
async function warmup(request, response) {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    await downloadService.warmCache(id, subLogger);
    response.status(200).send('Warmup successful');
  } catch (error) {
    subLogger.error(`Error in warmup: ${error.message}`, { error });
    response.status(500).send(error.message);
  }
}

/**
 * Check if the video with the given ID is in the cache
 * @param request
 * @param response
 * @returns {Promise<void>}
 */
async function has(request, response) {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    const isCached = await downloadService.has(id);
    response.status(200).send({ cached: isCached });
  } catch (error) {
    subLogger.error(`Error in has: ${error.message}`, { error });
    response.status(500).send('Error checking cache');
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
