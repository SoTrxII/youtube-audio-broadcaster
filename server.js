const logger = require('pino')({ level: 'debug' });
const expressLogger = require('pino-http')({ logger });
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { downloadService } = require('./dependency-injection');
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
    await downloadService.streamMp3(id, response, subLogger);
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

app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));
