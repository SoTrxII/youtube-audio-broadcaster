const request = require('supertest');
const assert = require('node:assert');
const { describe, it, after } = require('node:test');
const { server } = require('./server'); // path to your server.js file

describe('GET /stream/:id', () => {
  const testVideoId = 'FKLtgamrhpk';
  after(() => {
    server.close();
  });

  it('responds with partial content when asked', async () => {
    await request.agent(server)
      .get(`/stream/${testVideoId}`)
      .set('Range', 'bytes=0-499999')
      .expect(206)
      .expect('Content-Type', /audio\/mpeg/)
      .expect('Accept-Ranges', 'bytes')
      .expect((res) => assert.notEqual(res.body.length, 0));
  });

  it('Handles weird range requests', async () => {
    await request.agent(server)
      .get(`/stream/${testVideoId}`)
    // This is literally asking for the whole stream but in a weird way
      .set('Range', 'bytes=0-')
      .expect(206)
      .expect('Content-Type', /audio\/mpeg/)
      .expect('Accept-Ranges', 'bytes')
      .expect((res) => assert.notEqual(res.body.length, 0));
  });
});
