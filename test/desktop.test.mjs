// The desktop app's screenshot service, and how lib/screenshot.mjs uses it.
// The service's renderer is swapped for a stub, so these run under plain Node
// without opening Electron.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCaptureService } from '../desktop/capture.mjs';
import { screenshot } from '../lib/screenshot.mjs';
import { nodeEnv } from '../lib/node-env.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ARTBOARD = 'http://127.0.0.1:4400/artboard/ab_1';
let service;
const rendered = [];
before(async () => {
  service = await startCaptureService({
    render: async (url, width, height) => {
      if (url.endsWith('/broken')) throw new Error('The artboard took more than 20 seconds to load.');
      rendered.push({ url, width, height });
      return PNG;
    },
  });
});
after(() => service.close());

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the service listens on 127.0.0.1 with a long secret in its path', () => {
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
});

test('without the secret, the service answers 404 and renders nothing', async () => {
  const origin = new URL(service.url).origin;
  for (const url of [`${origin}/`, `${origin}/wrong`, `${service.url}x`]) {
    const res = await post(url, { url: ARTBOARD, width: 390, height: 844 });
    assert.equal(res.status, 404, url);
  }
  assert.equal((await fetch(service.url)).status, 404, 'GET is refused too');
  assert.equal(rendered.length, 0);
});

test('only artboard pages on 127.0.0.1 are rendered', async () => {
  for (const url of ['https://example.com/', 'http://localhost:4400/artboard/ab_1', 'http://127.0.0.1:4400/api/board', 'file:///etc/passwd', 'http://127.0.0.1:4400/artboard/../api']) {
    const res = await post(service.url, { url, width: 390, height: 844 });
    assert.equal(res.status, 400, url);
  }
  assert.equal(rendered.length, 0);
});

test('sizes must be whole numbers from 1 to 4000', async () => {
  for (const [width, height] of [[0, 100], [100, 4001], [1.5, 100], ['390', 844]]) {
    const res = await post(service.url, { url: ARTBOARD, width, height });
    assert.equal(res.status, 400, `${width}×${height}`);
  }
});

test('screenshot() asks the service when BLUEPRINT_CAPTURE is set, and returns its PNG', async () => {
  const png = await screenshot(ARTBOARD, 390, 844, { service: service.url });
  assert.deepEqual(png, PNG);
  assert.deepEqual(rendered.at(-1), { url: ARTBOARD, width: 390, height: 844 });
});

test("screenshot() passes on the app's own error instead of trying Chrome", async () => {
  await assert.rejects(screenshot('http://127.0.0.1:4400/artboard/broken', 390, 844, { service: service.url }), /more than 20 seconds/);
});

test('nodeEnv adds ELECTRON_RUN_AS_NODE only inside Electron', () => {
  const env = { A: '1' };
  assert.equal(nodeEnv(env), env, 'plain Node leaves the environment alone');
  assert.equal(nodeEnv(env).ELECTRON_RUN_AS_NODE, undefined);
});
