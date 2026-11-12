// Fetches a web page's title and description for a link card. This is a nicety:
// any failure returns null and the card keeps the address's host as its title.
//
// The server makes this request, not the browser, so it refuses addresses on
// this machine or the local network. Otherwise a link card could be used to
// make Blueprint read a router admin page or another local service.
//
// The address check runs inside the connection's own DNS lookup, so the address
// that is checked is the address that is used. A name that resolves to a public
// address for a check and a private one for the request cannot slip through.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const MAX_BYTES = 512 * 1024; // the most read from the network
const PARSE_BYTES = 64 * 1024; // the most searched for a title

// Loopback, private, link-local, shared, reserved and multicast ranges, and the
// IPv6 forms that wrap an IPv4 address (mapped, compatible, NAT64 and 6to4),
// which would otherwise hide 127.0.0.1 inside an IPv6 address.
// Two lists, one per family. Node checks an IPv4 address against IPv6 rules
// too (as ::ffff:a.b.c.d), so one shared list with the mapped range in it
// would refuse every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
])
  blocked4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
])
  blocked6.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return blocked4.check(ip, 'ipv4');
  if (family === 6) return blocked6.check(ip, 'ipv6');
  return true; // not an address at all: refuse
}

// A DNS lookup for http.request that refuses private answers.
function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return callback(new Error('private address refused'));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

// One GET. Resolves { status, location, type, body } with at most MAX_BYTES of body.
function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Node skips the lookup for an address written in the URL, so check it here.
    if (isIP(host) && isPrivateAddress(host)) return reject(new Error('private address refused'));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { lookup: safeLookup, timeout: timeoutMs, headers: { accept: 'text/html', 'user-agent': 'Blueprint link preview' } }, (res) => {
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ status: res.statusCode, location: res.headers.location });
      }
      if (res.statusCode !== 200 || !type.includes('text/html')) {
        res.resume();
        return resolve({ status: res.statusCode });
      }
      // A streaming decoder keeps a character that falls across two chunks whole.
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        body += decoder.decode(chunk, { stream: true });
        if (bytes > MAX_BYTES || /<\/head>/i.test(body.slice(-chunk.length - 8))) res.destroy();
      });
      const done = () => resolve({ status: 200, type, body: body + decoder.decode() });
      res.on('end', done);
      res.on('close', done);
    });
    // `timeout` above only fires when the connection goes quiet. This one caps
    // the whole request, so a page that trickles bytes cannot hold it open.
    const cap = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs * 2);
    req.on('close', () => clearTimeout(cap));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/\s+/g, ' ')
    .trim();

// Read the title and description from the top of a page. Every pattern is
// bounded and runs on at most PARSE_BYTES, so a hostile page cannot make the
// matching slow.
export function parsePreview(html) {
  const head = html.slice(0, PARSE_BYTES);
  const end = head.search(/<\/head>/i);
  const text = end === -1 ? head : head.slice(0, end);
  const metas = new Map();
  for (const tag of text.match(/<meta\b[^<>]{0,2000}>/gi) || []) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"'<>]{1,100})["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"'<>]{0,1000})["']/i)?.[1];
    if (name && content && !metas.has(name)) metas.set(name, decode(content));
  }
  const pick = (...names) => names.map((n) => metas.get(n)).find(Boolean) || '';
  const title = pick('og:title', 'twitter:title') || decode(text.match(/<title\b[^<>]{0,200}>([^<>]{0,500})<\/title>/i)?.[1] || '');
  const description = pick('og:description', 'description', 'twitter:description');
  return title || description ? { title: title.slice(0, 120), description: description.slice(0, 400) } : null;
}

export async function fetchPreview(url, { timeoutMs = 4000 } = {}) {
  try {
    let current = new URL(url);
    // Follow up to three redirects by hand. Every hop gets the same checks.
    for (let hop = 0; hop < 4; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
      const res = await get(current, timeoutMs);
      if (res.location) {
        current = new URL(res.location, current);
        continue;
      }
      return res.body ? parsePreview(res.body) : null;
    }
    return null;
  } catch {
    return null;
  }
}
