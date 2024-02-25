
const path = require("path");

const express = require("express");
const ytdl = require("@distube/ytdl-core");
const ffmpeg = require('fluent-ffmpeg');
const logger = require('pino')( {level: 'debug'});

const expressLogger = require('pino-http')({logger: logger});
const sendSeekable = require('send-seekable');


// Express settings

const app = express();
app.use(sendSeekable);
app.use(expressLogger);

app.set('port', process.env.PORT || 3000);

app.get('/stream/:id', async function (request, response) {
    const url = 'https://www.youtube.com/watch?v=' + request.params.id;
    request.log.info(url);
    try{
        if(!await ytdl.validateURL(url)){
            throw new Error(`Invalid youtube url : ${url}`);
        }
        const stream =  ytdl(url, { filter: 'audioonly' });
        stream.on("info", (_, format) => {
            logger.debug(`"${url}" content length : ${format.contentLength}`);
            response.sendSeekable(stream, {
                length: format.contentLength || 5000000
            });
        });
    }catch (e){
        logger.error(e);
        response.statusCode = 400;
        response.end("This isn't a correct Yt video link");
    }

    
});

app.get('/download/mp3/:id', async function (request, response) {
    request.log.debug('https://www.youtube.com/watch?v=' + request.params.id);
    const url = 'https://www.youtube.com/watch?v=' + request.params.id;
    try{
        await ytdl.getInfo(url);
        ffmpeg(ytdl(url, { filter: 'audioonly' }))
            .on("error", console.error)
            .toFormat('mp3')
            .audioBitrate("192k")
            .noVideo()
            .pipe(response);
    } catch (e) {
        response.statusCode = 400;
        response.end("This isn't a correct Yt video link");
        logger.error(e);
    }
});

app.listen(app.get('port'), function () {
    logger.info('Started web server on port: ' + app.get('port'));
});

module.exports = {};