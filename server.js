
const path = require("path");

const express = require("express");
const ytdl = require("ytdl-core");

// Express settings

const app = express();

app.set('port', process.env.PORT || 3000);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Express routing

app.use(express.static(path.join(__dirname, 'public')));


app.get('/stream/:id', function (request, response) {
    console.log('https://www.youtube.com/watch?v=' + request.params.id);
    ytdl('https://www.youtube.com/watch?v=' + request.params.id, { filter: 'audioonly' }).pipe(response);
});

app.listen(app.get('port'), function () {
    console.log('Started web server on port: ' + app.get('port'));
});

module.exports = {};