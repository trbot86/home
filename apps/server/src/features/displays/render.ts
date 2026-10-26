import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { displayAssetsRoot } from '../../paths.js';
import type { DisplayModel, DisplaySection } from './projection.js';

const font: NonNullable<ResvgRenderOptions['font']> = {
  loadSystemFonts: false,
  defaultFontFamily: 'Atkinson Hyperlegible',
  fontFiles: [
    join(displayAssetsRoot, 'AtkinsonHyperlegible-Regular.ttf'),
    join(displayAssetsRoot, 'AtkinsonHyperlegible-Bold.ttf'),
  ],
};
const escape = (text: string) =>
  text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
const text = (value: string, x: number, y: number, size: number, bold = false) =>
  `<text x="${x}" y="${y}" font-family="Atkinson Hyperlegible" font-size="${size}" font-weight="${bold ? 700 : 400}">${escape(value)}</text>`;
const widthCache = new Map<string, number>();
function width(value: string, size: number, bold = false) {
  const key = `${size}/${bold}/${value}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  const measure = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="100">${text(value, 0, 50, size, bold)}</svg>`,
    { font },
  );
  const result = measure.getBBox()?.width ?? 0;
  // Keep render text out of a long-lived cross-request cache.
  widthCache.set(key, result);
  return result;
}
function fit(value: string, available: number, size: number, bold = false) {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (width(clean, size, bold) <= available) return clean;
  const chars = Array.from(clean);
  let low = 0,
    high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (width(chars.slice(0, mid).join('') + '…', size, bold) <= available) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('').trimEnd() + '…';
}
function wrap(value: string, available: number, size: number): string[] {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (width(clean, size, true) <= available) return [clean];
  const first = fit(clean, available, size, true).replace(/…$/, '');
  const boundary = first.lastIndexOf(' '),
    split = boundary > first.length / 2 ? boundary : first.length;
  return [clean.slice(0, split), fit(clean.slice(split), available, size, true)];
}
function section(value: DisplaySection, x: number, y: number, w: number, height: number, rowHeight: number) {
  const clip = `section-${x}-${y}`;
  let svg =
    `<defs><clipPath id="${clip}"><rect x="${x}" y="${y - 20}" width="${w}" height="${height + 25}"/></clipPath></defs><g clip-path="url(#${clip})">` +
    text(value.title.toUpperCase(), x, y, 17, true);
  const extra = Math.max(0, ...value.rows.map((r) => (r.prefix ? 24 : r.detail ? 22 : 0))) + 5;
  let capacity = Math.max(1, 1 + Math.floor((height - 31 - extra) / rowHeight));
  if (value.rows.length > capacity)
    capacity = Math.max(1, 1 + Math.floor((height - 31 - extra - 20) / rowHeight));
  const rows = value.rows.slice(0, capacity);
  if (!rows.length) return svg + text(fit(value.empty, w, 19), x, y + 32, 19) + '</g>';
  for (const [i, row] of rows.entries()) {
    const top = y + 31 + i * rowHeight,
      labelX = row.prefix ? x + 78 : x;
    if (row.prefix)
      row.prefix.split('\n').forEach((part, n) => {
        svg += text(fit(part, 72, 17), x, top + n * 22, 17);
      });
    const lines = row.prefix ? wrap(row.title, w - 78, 21) : [fit(row.title, w, 21, true)];
    lines.forEach((line, n) => {
      svg += text(line, labelX, top + n * 24, 21, true);
    });
    if (row.detail) svg += text(fit(row.detail, w, 16), x, top + 22, 16);
  }
  if (value.rows.length > capacity)
    svg += text(`+${value.rows.length - capacity} more in Our Place`, x, y + height - 1, 15);
  return svg + '</g>';
}

/** One canonical 1-bit raster, encoded for both browser preview and the device. */
export function renderDisplay(model: DisplayModel, size = { width: 800, height: 480 }) {
  const { width: w, height: h } = size;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 320 || w > 1600 || h < 240 || h > 1200)
    throw Error('Invalid display size');
  widthCache.clear();
  try {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 800 480"><rect width="800" height="480" fill="white"/><g fill="black">`;
    svg += text(fit(model.title, 480, 32, true), 24, 40, 32, true) + text(model.date, 570, 38, 23);
    svg += '<path d="M24 58H776M414 76V433M24 448H776" stroke="black" stroke-width="1"/>';
    if (model.layout === 'kitchen') {
      svg += section(model.sections[0]!, 24, 88, 366, 342, 50);
      svg += section(model.sections[1]!, 438, 88, 338, 133, 46);
      svg += section(model.sections[2]!, 438, 248, 338, 76, 30);
      svg += section(model.sections[3]!, 438, 338, 338, 96, 30);
    } else {
      svg += section(model.sections[0]!, 24, 88, 366, 342, 50);
      svg += section(model.sections[1]!, 438, 88, 338, 342, 50);
    }
    svg += text(model.footer, 24, 470, 15);
    svg += text(
      model.warnings.length
        ? 'Calendar data needs attention'
        : model.layout === 'kitchen'
          ? 'Weather not connected'
          : 'Our Place',
      494,
      470,
      15,
    );
    svg += '</g></svg>';
    const rendered = new Resvg(svg, { font, background: 'white' }).render();
    const rgba = rendered.pixels,
      stride = Math.ceil(w / 8),
      pixels = Buffer.alloc(stride * h, 255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4;
        if ((rgba[at]! + rgba[at + 1]! + rgba[at + 2]!) / 3 < 160)
          pixels[y * stride + (x >> 3)]! &= ~(128 >> (x & 7));
      }
    return {
      width: w,
      height: h,
      digest: createHash('sha256').update(`${w}x${h}/mono-v1/`).update(pixels).digest('hex'),
      png: encodePng(pixels, w, h),
      bmp: encodeBmp(pixels, w, h),
    };
  } finally {
    widthCache.clear();
  }
}

export function encodeBmp(pixels: Buffer, w: number, h: number) {
  const row = Math.ceil(w / 32) * 4,
    source = Math.ceil(w / 8),
    out = Buffer.alloc(62 + row * h);
  out.write('BM');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(62, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(1, 28);
  out.writeUInt32LE(row * h, 34);
  out.writeUInt32LE(2, 46);
  out.fill(255, 58, 61);
  for (let y = 0; y < h; y++) pixels.copy(out, 62 + (h - y - 1) * row, y * source, (y + 1) * source);
  return out;
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export function encodePng(pixels: Buffer, w: number, h: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 1; // 1-bit grayscale, 0 black / 1 white.
  const stride = Math.ceil(w / 8),
    scan = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) pixels.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scan)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
