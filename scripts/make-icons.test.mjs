import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { GREEN, ICONS, renderIcon } from "./make-icons.mjs";

const ICON_DIR = new URL("../public/icons/", import.meta.url);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const committed = (file) => readFileSync(new URL(file, ICON_DIR));

/** The chunks of a PNG, in order. */
function chunks(png) {
  const list = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    list.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return list;
}

/** Decodes the 8-bit RGB or RGBA PNGs the generator writes (filter types 0 and 2 only) into rows of pixels. */
function decode(png) {
  const all = chunks(png);
  const header = all[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = header[9] === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * channels;
  assert.equal(raw.length, height * (stride + 1), "image data has one filter byte and one row per line");
  const rows = [];
  let above = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    assert.ok(filter === 0 || filter === 2, `row ${y} uses filter ${filter}`);
    if (filter === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + above[i]) & 0xff;
    rows.push(line);
    above = line;
  }
  return { width, height, channels, rows };
}

test("the generator lists the five icons the manifest and the layout link, at their named sizes", () => {
  assert.deepEqual(
    ICONS.map((icon) => [icon.file, icon.size]),
    [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["icon-maskable-512.png", 512],
      ["apple-touch-icon.png", 180],
      ["favicon-32.png", 32],
    ],
  );
});

test("each committed icon is a valid PNG of its named size whose image data decodes", () => {
  for (const icon of ICONS) {
    const png = committed(icon.file);
    assert.deepEqual(png.subarray(0, 8), SIGNATURE, icon.file);
    const all = chunks(png);
    assert.equal(all[0].type, "IHDR", icon.file);
    assert.equal(all.at(-1).type, "IEND", icon.file);
    const { width, height } = decode(png);
    assert.equal(width, icon.size, icon.file);
    assert.equal(height, icon.size, icon.file);
  }
});

test("the generator's output is byte-identical to the committed icons, so they cannot drift", () => {
  for (const icon of ICONS) {
    assert.ok(renderIcon(icon).equals(committed(icon.file)), `${icon.file}: run node scripts/make-icons.mjs`);
  }
});

test("the apple-touch and maskable icons are opaque; the others have see-through corners", () => {
  for (const icon of ICONS) {
    const { channels, rows } = decode(committed(icon.file));
    if (icon.file === "apple-touch-icon.png" || icon.file === "icon-maskable-512.png") {
      assert.equal(channels, 3, `${icon.file} has no alpha channel`);
    } else {
      assert.equal(channels, 4, icon.file);
      assert.equal(rows[0][3], 0, `${icon.file} top-left corner is transparent`);
    }
  }
});

const hex = (pixel) => `#${[...pixel.subarray(0, 3)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

test("the icon green is the --green token in public/board.css, and the middle of the tile is that green", () => {
  const css = readFileSync(new URL("../public/board.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`--green: ${GREEN};`));
  for (const icon of ICONS) {
    const { channels, rows } = decode(committed(icon.file));
    // Just inside the left edge, half way down: the tile, never the glyph.
    const x = Math.floor(icon.size * 0.1);
    const pixel = rows[Math.floor(icon.size / 2)].subarray(x * channels, (x + 1) * channels);
    assert.equal(hex(pixel), GREEN, icon.file);
  }
});

test("the maskable icon keeps its white glyph inside the central 80% safe zone", () => {
  const { width, rows } = decode(committed("icon-maskable-512.png"));
  const centre = width / 2;
  const safe = width * 0.4;
  let glyph = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (hex(row.subarray(x * 3, x * 3 + 3)) === GREEN) continue;
      glyph++;
      assert.ok(Math.hypot(x + 0.5 - centre, y + 0.5 - centre) < safe, `pixel ${x},${y} is outside the safe zone`);
    }
  });
  assert.ok(glyph > 1000, "the glyph is drawn");
});
