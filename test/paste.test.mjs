// What pasted text turns into on the canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { URL_ONLY, FENCE, isHtml, looksLikeCode, htmlName } from '../public/paste.js';

test('a web address on its own is a link', () => {
  assert.ok(URL_ONLY.test('https://example.com/a?b=1'));
  assert.ok(!URL_ONLY.test('see https://example.com'));
});

test('HTML is recognised, prose with a < is not', () => {
  assert.ok(isHtml('<!doctype html><html><body><h1>Hi</h1></body></html>'));
  assert.ok(isHtml('<section class="hero">\n  <h1>Tidewater</h1>\n</section>'));
  assert.ok(isHtml('<button>Book</button>'));
  assert.ok(isHtml('<img src="a.png" alt="" />'));
  assert.ok(!isHtml('2 < 3 and 5 > 4'));
  assert.ok(!isHtml('<b> is a tag name'));
  assert.ok(!isHtml('Make the <button> quieter'));
});

test('code is recognised by a fence or by its lines', () => {
  assert.equal('```css\n.a { color: red; }\n```'.match(FENCE)[2], '.a { color: red; }');
  assert.ok(looksLikeCode('const a = 1;\nconst b = a + 1;'));
  assert.ok(looksLikeCode('.hero {\n  padding: 64px;\n  color: #111;\n}'));
  assert.ok(looksLikeCode('function go() {\n  return 1;\n}'));
  assert.ok(looksLikeCode('import x from "y";'));
});

test('ordinary notes are not code', () => {
  assert.ok(!looksLikeCode('Calm, coastal, one clear action.\nKeep the black pill button.'));
  assert.ok(!looksLikeCode('# Brief\nWarmer palette\nLess copy'));
  assert.ok(!looksLikeCode('If the hero feels loud, cut the subtitle.'));
  assert.ok(!looksLikeCode('Headline idea: Walk the edge of the sea'));
});

test('pasted HTML is named from its title or first heading', () => {
  assert.equal(htmlName('<html><head><title>Pricing &amp; plans</title></head></html>'), 'Pricing plans (pasted)');
  assert.equal(htmlName('<section><h2>Book a walk</h2></section>'), 'Book a walk (pasted)');
  assert.equal(htmlName('<div>hi</div>'), 'Pasted HTML');
});
