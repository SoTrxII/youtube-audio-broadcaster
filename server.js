const logger = require('pino')({ level: 'debug' });
const expressLogger = require('pino-http')({ logger });
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { downloadService } = require('./dependency-injection');

const app = express();
app.use(expressLogger);
app.set('port', process.env.PORT || 3000);

app.get('/download/mp3/:id', async (request, response) => {
  const { id } = request.params;
  const subLogger = logger.child({ requestId: uuidv4(), videoId: id });

  try {
    response.setHeader('Content-Type', 'audio/mpeg');
    await downloadService.streamMp3(id, response, subLogger);
  } catch (error) {
    response.status(500).send('Error streaming audio data');
    subLogger.error(`Error streaming audio data: ${error.message}`, { error });
  }
});

app.listen(app.get('port'), () => logger.info(`Started web server on port: ${app.get('port')}`));
