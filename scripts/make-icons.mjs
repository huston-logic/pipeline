// `node scripts/make-icons.mjs`: draws the board's home-screen icons and favicon into public/icons/ (decision 0019).
// Generic on purpose (every copy runs the same code): a green tile with a white three-column board glyph, never a
// company's logo. Node built-ins only. The deflate step is written here (fixed Huffman codes, runs only) instead of
// using zlib, because zlib's output can differ between Node versions and CPUs, and a test checks that this script's
// output is byte-identical to the committed files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The --green token in public/board.css (a test keeps the two in step). */
export const GREEN = "#2b6455";

/**
 * tile "rounded": a rounded square with see-through corners; "full": the whole square, opaque (iOS rounds the
 * apple-touch icon itself, and Android masks the maskable one). glyph: the glyph's width and height as a share of the
 * icon. The maskable glyph is 0.4 wide, so its corners sit 0.28 from the centre, inside the 0.4 safe-zone radius.
 */
export const ICONS = [
  { file: "icon-192.png", size: 192, tile: "rounded", glyph: 0.56 },
  { file: "icon-512.png", size: 512, tile: "rounded", glyph: 0.56 },
  { file: "icon-maskable-512.png", size: 512, tile: "full", glyph: 0.4 },
  { file: "apple-touch-icon.png", size: 180, tile: "full", glyph: 0.56 },
  { file: "favicon-32.png", size: 32, tile: "rounded", glyph: 0.62 },
];

const TILE_RADIUS = 0.2;
const BAR_HEIGHTS = [1, 0.62, 0.8];
const SAMPLES = 4;

const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const WHITE = [255, 255, 255];

/** True when (x, y) is inside the rectangle (x0, y0)-(x1, y1) with corners rounded to r. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

/** Three top-aligned bars of different heights, like columns on a board, centred in a square `size` wide. */
function glyphBars(size) {
  const start = (1 - size) / 2;
  const width = size * 0.26;
  const gap = (size - 3 * width) / 2;
  return BAR_HEIGHTS.map((height, i) => {
    const x0 = start + i * (width + gap);
    return { x0, y0: start, x1: x0 + width, y1: start + size * height, r: width * 0.3 };
  });
}

/** The icon as rows of 8-bit RGB (opaque) or RGBA pixels, each pixel averaged over SAMPLES x SAMPLES points. */
function draw({ size, tile, glyph }) {
  const green = rgb(GREEN);
  const bars = glyphBars(glyph);
  const channels = tile === "full" ? 3 : 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(size * channels);
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (tile === "rounded" && !inRoundedRect(x, y, 0, 0, 1, 1, TILE_RADIUS)) continue;
          const colour = bars.some((b) => inRoundedRect(x, y, b.x0, b.y0, b.x1, b.y1, b.r)) ? WHITE : green;
          for (let c = 0; c < 3; c++) sum[c] += colour[c];
          covered++;
        }
      }
      const at = px * channels;
      for (let c = 0; c < 3; c++) row[at + c] = covered === 0 ? 0 : Math.round(sum[c] / covered);
      if (channels === 4) row[at + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
    }
    rows.push(row);
  }
  return { channels, rows };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

/** A zlib stream (RFC 1950) holding one fixed-Huffman deflate block (RFC 1951) whose only matches are runs. */
function deflate(data) {
  const out = [];
  let bits = 0;
  let count = 0;
  const put = (value, n) => {
    bits |= value << count;
    count += n;
    while (count >= 8) {
      out.push(bits & 0xff);
      bits >>>= 8;
      count -= 8;
    }
  };
  // Huffman codes are packed most significant bit first.
  const code = (value, n) => {
    for (let i = n - 1; i >= 0; i--) put((value >>> i) & 1, 1);
  };
  const symbol = (s) => {
    if (s < 144) code(0x30 + s, 8);
    else if (s < 256) code(0x190 + s - 144, 9);
    else if (s < 280) code(s - 256, 7);
    else code(0xc0 + s - 280, 8);
  };

  put(1, 1); // last block
  put(1, 2); // fixed Huffman codes
  for (let i = 0; i < data.length; ) {
    let run = 0;
    if (i > 0) while (run < 258 && i + run < data.length && data[i + run] === data[i - 1]) run++;
    if (run >= 3) {
      let index = LENGTH_BASE.length - 1;
      while (LENGTH_BASE[index] > run) index--;
      symbol(257 + index);
      put(run - LENGTH_BASE[index], LENGTH_EXTRA[index]);
      code(0, 5); // distance 1
      i += run;
    } else {
      symbol(data[i]);
      i++;
    }
  }
  symbol(256);
  if (count > 0) put(0, 8 - count);

  const check = Buffer.alloc(4);
  check.writeUInt32BE(adler32(data));
  return Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from(out), check]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** One icon as PNG bytes. Every row uses the Up filter, so rows like the one above become runs of zeros. */
export function renderIcon(icon) {
  const { channels, rows } = draw(icon);
  const stride = icon.size * channels;
  const raw = Buffer.alloc(rows.length * (stride + 1));
  let above = Buffer.alloc(stride);
  rows.forEach((row, y) => {
    const at = y * (stride + 1);
    raw[at] = 2;
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (row[i] - above[i]) & 0xff;
    above = row;
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(icon.size, 0);
  header.writeUInt32BE(icon.size, 4);
  header[8] = 8; // bits per channel
  header[9] = channels === 4 ? 6 : 2; // RGBA or RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writeIcons(dir = fileURLToPath(new URL("../public/icons/", import.meta.url))) {
  mkdirSync(dir, { recursive: true });
  for (const icon of ICONS) writeFileSync(join(dir, icon.file), renderIcon(icon));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeIcons();
  console.log("Wrote public/icons/ (home-screen icons and favicon).");
}
