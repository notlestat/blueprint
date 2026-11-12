// Shared test data. This file has no tests of its own.

// A 3 by 2 PNG header and body, so sniffImage reads a real header.
export const PNG_3x2 = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000300000002080200000012167f8a0000001249444154789c63f8cfc0f01f0c18fe030028f405fbb4d3c3e70000000049454e44ae426082',
  'hex',
);
