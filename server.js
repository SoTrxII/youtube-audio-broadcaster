
const path = require("path");

const express = require("express");
const ytdl = require("ytdl-core");
const ffmpeg = require('fluent-ffmpeg');
const sendSeekable = require('send-seekable');


// Express settings

const app = express();
app.use(sendSeekable);

app.set('port', process.env.PORT || 3000);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Express routing

app.use(express.static(path.join(__dirname, 'public')));


app.get('/stream/:id', function (request, response) {
    console.log('https://www.youtube.com/watch?v=' + request.params.id);
    const stream = ytdl('https://www.youtube.com/watch?v=' + request.params.id, { filter: 'audioonly' });
    stream.on("info", (_, format) => {
        console.log(format.contentLength);
        response.sendSeekable(stream, {
            length: format.contentLength || 5000000
        });
    });
    
});

app.get('/download/mp3/:id', async function (request, response) {
    const url = 'https://www.youtube.com/watch?v=' + request.params.id
    console.log(url);
    try{
        await ytdl.getInfo(url);
        ffmpeg(ytdl(url))
            .on("error", console.error)
            .toFormat('mp3')
            .audioBitrate("192k")
            .noVideo()
            .pipe(response);
    } catch (e) {
        response.statusCode = 400;
        response.end("This isn't a correct Yt video link");
        console.error(e);
    }
});

app.listen(app.get('port'), function () {
    console.log('Started web server on port: ' + app.get('port'));
});

module.exports = {};