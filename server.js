
const path = require("path");

const express = require("express");
const ytdl = require("ytdl-core");
const {pipeline} = require("stream");
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
    const stream = ytdl('https://www.youtube.com/watch?v=' + request.params.id, { filter: 'audioonly', highWaterMark : 50 * 100 * 100 });
    stream.on("info", (_, format) => {
        response.sendSeekable(stream, {
            length: format.contentLength
        });
    });
    
});

app.listen(app.get('port'), function () {
    console.log('Started web server on port: ' + app.get('port'));
});

module.exports = {};