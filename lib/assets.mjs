// Reference images. Blueprint decides what an uploaded file is from its first
// bytes, never from the name or the Content-Type the sender claims. Only four
// raster formats are accepted. SVG is refused because an SVG file can carry script.

export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Returns { ext, width, height } for a supported image, or null.
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG: fixed signature, then the IHDR chunk holds width and height.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a)
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };

  // GIF: "GIF87a" or "GIF89a", then little-endian width and height.
  if (buf.toString('latin1', 0, 4) === 'GIF8')
    return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };

  // WebP: a RIFF container. Three chunk kinds store the size in different ways.
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { ext: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return null;
  }

  // JPEG: walk the segments until a start-of-frame marker, which holds the size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { ext: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
