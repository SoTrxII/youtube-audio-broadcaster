const request = require('supertest');
const assert = require('node:assert');
const { describe, it, after } = require('node:test');
const { server } = require('./server'); // path to your server.js file

describe('GET /stream/:id', () => {
  const testVideoId = 'miomuSGoPzI';
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

  it('Handles two parallel requests without without blocking', { skip: true }, async () => {
    const [res1, res2] = await Promise.all([
      request.agent(server).get(`/stream/${testVideoId}`).set('Range', 'bytes=0-499999'),
      request.agent(server).get(`/stream/${testVideoId}`).set('Range', 'bytes=500000-999999'),
    ]);
    assert.equal(res1.status, 206);
    assert.equal(res2.status, 206);
  });
});
