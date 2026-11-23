// news-image-20261123 v2 — "MONDAY 23 NOVEMBER 2026" Mid-day Edition
// Single-file Node (stdlib only) renderer. Writes ONE 1024x1024 PNG to
// /output/entry.png (or $OUTPUT). Deterministic: no Date, no Math.random,
// no network, fixed iteration order everywhere.
//
// TEXT: a fresh vector-stroke font (Hershey-style polylines, written for this
// entry) rasterized with Xiaolin Wu anti-aliased lines + round caps.
// Normal smooth letterforms everywhere — NO pixel/dot-matrix font.
// Serif mode adds small ticks at steep stroke ends (top/bottom of stems).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------- canvas
const W = 1024;
const H = 1024;
const buf = Buffer.alloc(W * H * 4); // RGBA, row-major

type RGB = [number, number, number];

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PAPER: RGB = hex("#f6efdb");
const PAPER2: RGB = hex("#efe6cc");
const INK: RGB = hex("#1b1712");
const RED: RGB = hex("#a81e22");
const DARKRED: RGB = hex("#7d1418");
const NAVY: RGB = hex("#1f4e79");
const TEAL: RGB = hex("#2e6b62");
const GOLD: RGB = hex("#b98a1e");
const GREY: RGB = hex("#6b6558");
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [20, 18, 14];

function fillAll(c: RGB): void {
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = c[0];
    buf[i * 4 + 1] = c[1];
    buf[i * 4 + 2] = c[2];
    buf[i * 4 + 3] = 255;
  }
}

// Blend an opaque colour over a pixel with coverage 0..1.
function plot(x: number, y: number, c: RGB, a: number): void {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H || a <= 0) return;
  if (a > 1) a = 1;
  const i = (yi * W + xi) * 4;
  const inv = 1 - a;
  buf[i] = Math.round(c[0] * a + buf[i] * inv);
  buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * inv);
  buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * inv);
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * W + xx) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = 255;
    }
  }
}

function rect(x: number, y: number, w: number, h: number, c: RGB, lw = 1): void {
  fillRect(x, y, w, lw, c);
  fillRect(x, y + h - lw, w, lw, c);
  fillRect(x, y, lw, h, c);
  fillRect(x + w - lw, y, lw, h, c);
}

// Hard (aliased) thin line — for art/rules only.
function line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (ax >= 0 && ay >= 0 && ax < W && ay < H) {
      const i = (ay * W + ax) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = 255;
    }
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      ax += sx;
    }
    if (e2 < dx) {
      err += dx;
      ay += sy;
    }
  }
}

// Scanline-filled polygon, hard edges (art only).
function fillPoly(pts: Array<[number, number]>, c: RGB): void {
  let minY = H;
  let maxY = 0;
  for (const p of pts) {
    minY = Math.min(minY, Math.floor(p[1]));
    maxY = Math.max(maxY, Math.ceil(p[1]));
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  const n = pts.length;
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y + 0.5 - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
        buf[i + 3] = 255;
      }
    }
  }
}

// Anti-aliased filled circle (distance-based coverage).
function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy));
      const a = Math.min(1, Math.max(0, r + 0.5 - d));
      if (a > 0) plot(x, y, c, a);
    }
  }
}

function circleOutline(cx: number, cy: number, r: number, c: RGB): void {
  const steps = Math.max(24, Math.floor(r * 6));
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    line(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, c);
  }
}

// ------------------------------------------------------- Xiaolin Wu AA line
function wuPlot(x: number, y: number, c: RGB, a: number, steep: boolean): void {
  if (steep) plot(y, x, c, a);
  else plot(x, y, c, a);
}

function wuLine(x0: number, y0: number, x1: number, y1: number, c: RGB, weight = 1): void {
  const frac = (v: number): number => v - Math.floor(v);
  let steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  if (steep) {
    [x0, y0] = [y0, x0];
    [x1, y1] = [y1, x1];
  }
  if (x0 > x1) {
    [x0, x1] = [x1, x0];
    [y0, y1] = [y1, y0];
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const grad = dx === 0 ? 1 : dy / dx;

  let xend = Math.round(x0);
  let yend = y0 + grad * (xend - x0);
  let xgap = 1 - frac(x0 + 0.5);
  let xpxl1 = xend;
  let ypxl1 = Math.floor(yend);
  wuPlot(xpxl1, ypxl1, c, (1 - frac(yend)) * xgap * weight, steep);
  wuPlot(xpxl1, ypxl1 + 1, c, frac(yend) * xgap * weight, steep);
  let intery = yend + grad;

  xend = Math.round(x1);
  yend = y1 + grad * (xend - x1);
  xgap = frac(x1 + 0.5);
  const xpxl2 = xend;
  const ypxl2 = Math.floor(yend);
  wuPlot(xpxl2, ypxl2, c, (1 - frac(yend)) * xgap * weight, steep);
  wuPlot(xpxl2, ypxl2 + 1, c, frac(yend) * xgap * weight, steep);

  for (let x = xpxl1 + 1; x < xpxl2; x++) {
    wuPlot(x, Math.floor(intery), c, (1 - frac(intery)) * weight, steep);
    wuPlot(x, Math.floor(intery) + 1, c, frac(intery) * weight, steep);
    intery += grad;
  }
}

// Thick AA line: several Wu lines at perpendicular sub-pixel offsets,
// plus round caps (AA circles) at the ends.
function thickLine(x0: number, y0: number, x1: number, y1: number, c: RGB, width: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) {
    fillCircle(x0, y0, width / 2, c);
    return;
  }
  const px = -dy / len;
  const py = dx / len;
  // Each offset Wu line is 1px wide and is drawn at FULL weight: neighbouring
  // offsets overlap and saturate the stroke core, while the fractional
  // coverage at the outer edges gives the anti-aliased falloff. (Weighting
  // by 1/n instead leaves the core at ~1/n opacity — dotted, faint text.)
  const n = Math.max(1, Math.round(width * 2));
  for (let i = 0; i < n; i++) {
    const off = (i + 0.5) / n - 0.5;
    wuLine(x0 + px * off * width, y0 + py * off * width, x1 + px * off * width, y1 + py * off * width, c, 1);
  }
  fillCircle(x0, y0, width / 2, c);
  fillCircle(x1, y1, width / 2, c);
}

// ---------------------------------------------------------------- PNG out
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  crc.copy(out, 8 + data.length);
  return out;
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ vector font
// Each glyph: strokes separated by "|"; each stroke: space-separated "x,y"
// points in a 8-wide x 16-tall grid, y=0 top, y=12 baseline, y=16 descender.
// Single-point strokes are dots. Written fresh for this entry.
const GLYPHS: Record<string, string> = {
  A: "0,12 4,0 8,12|2,8 6,8",
  B: "0,0 0,12|0,0 5,0 7,2 7,5 5,6 0,6|0,6 5,6 7,8 7,10 5,12 0,12",
  C: "7,2 5,0 2,0 0,2 0,10 2,12 5,12 7,10",
  D: "0,0 0,12|0,0 5,0 8,3 8,9 5,12 0,12",
  E: "7,0 0,0 0,12 7,12|0,6 5,6",
  F: "7,0 0,0 0,12|0,6 5,6",
  G: "7,2 5,0 2,0 0,2 0,10 2,12 5,12 8,9 8,6 5,6",
  H: "0,0 0,12|8,0 8,12|0,6 8,6",
  I: "2,0 6,0|4,0 4,12|2,12 6,12",
  J: "4,0 8,0|6,0 6,10 4,12 2,12 0,10",
  K: "0,0 0,12|7,0 0,6|2,6 7,12",
  L: "0,0 0,12 7,12",
  M: "0,12 0,0 4,8 8,0 8,12",
  N: "0,12 0,0 8,12 8,0",
  O: "2,0 6,0 8,2 8,10 6,12 2,12 0,10 0,2 2,0",
  P: "0,12 0,0 5,0 7,2 7,5 5,6 0,6",
  Q: "2,0 6,0 8,2 8,10 6,12 2,12 0,10 0,2 2,0|5,9 8,12",
  R: "0,12 0,0 5,0 7,2 7,5 5,6 0,6|4,6 8,12",
  S: "7,2 5,0 2,0 0,2 0,5 2,6 6,6 8,7 8,10 6,12 3,12 1,10",
  T: "0,0 8,0|4,0 4,12",
  U: "0,0 0,9 2,12 6,12 8,9 8,0",
  V: "0,0 4,12 8,0",
  W: "0,0 2,12 4,5 6,12 8,0",
  X: "0,0 8,12|8,0 0,12",
  Y: "0,0 4,6 8,0|4,6 4,12",
  Z: "0,0 8,0 0,12 8,12",
  a: "6,4 6,12|6,8 4,8 2,8 2,10 2,12 4,12 6,12",
  b: "0,0 0,12|0,8 2,8 5,8 6,9 6,11 5,12 2,12 0,12",
  c: "6,6 4,4 2,4 0,6 0,10 2,12 4,12 6,10",
  d: "8,0 8,12|8,8 6,8 3,8 2,9 2,11 3,12 6,12 8,12",
  e: "1,8 6,8|6,8 6,6 5,4 3,4 1,6 1,8 1,10 2,12 4,12 6,11 6,9",
  f: "2,12 2,2 3,0 5,0 6,1|0,4 5,4",
  g: "6,4 6,12 6,15 4,16 2,16 1,15|6,8 4,8 2,8 2,10 2,12 4,12 6,12",
  h: "0,0 0,12|0,8 2,4 4,4 6,6 6,12",
  i: "3,4 3,12|3,1",
  j: "5,4 5,14 3,16 1,16 0,15|5,1",
  k: "0,0 0,12|6,4 0,8|2,8 6,12",
  l: "3,0 3,12",
  m: "0,12 0,4 2,4 4,6 4,12|4,6 6,4 8,5 8,12",
  n: "0,12 0,4 2,4 4,4 6,6 6,12",
  o: "2,4 5,4 6,6 6,10 5,12 2,12 1,10 1,6 2,4",
  p: "0,4 0,16|0,8 2,8 5,8 6,9 6,11 5,12 2,12 0,12",
  q: "8,4 8,16|8,8 6,8 3,8 2,9 2,11 3,12 6,12 8,12",
  r: "0,12 0,4|0,7 2,4 4,4 6,6",
  s: "6,6 4,4 2,4 1,5 1,7 2,8 5,8 6,9 6,11 4,12 2,12 1,11",
  t: "3,1 3,11 4,12 6,12|1,4 5,4",
  u: "0,4 0,10 1,12 3,12 5,12 6,10 6,4",
  v: "0,4 3,12 6,4",
  w: "0,4 1,12 3,7 5,12 6,4",
  x: "0,4 6,12|6,4 0,12",
  y: "0,4 3,12 6,4|3,12 3,15 2,16 0,16",
  z: "0,4 6,4 0,12 6,12",
  "0": "2,0 6,0 8,2 8,10 6,12 2,12 0,10 0,2 2,0",
  "1": "2,2 4,0 4,12|1,12 7,12",
  "2": "1,2 3,0 6,0 7,2 7,5 1,12 7,12",
  "3": "1,2 3,0 6,0 7,2 7,4 5,6 7,8 7,10 6,12 3,12 1,10",
  "4": "5,0 5,12|0,8 5,0|0,8 6,8",
  "5": "7,0 0,0 0,6 5,6 7,8 7,10 5,12 2,12 0,10",
  "6": "7,1 5,0 2,0 0,2 0,10 2,12 5,12 7,10 7,8 5,6 2,6 0,8",
  "7": "0,0 8,0 3,12",
  "8": "2,0 6,0 8,2 8,4 6,6 2,6 0,4 0,2 2,0|2,6 6,6 8,8 8,10 6,12 2,12 0,10 0,8 2,6",
  "9": "2,0 5,0 7,2 7,4 5,6 2,6 0,4 0,2 2,0|7,6 7,10 5,12 2,12 1,11",
  ".": "4,11",
  ",": "4,11|4,11 3.5,13 3,14",
  ":": "4,4|4,10",
  ";": "4,5|4,10 3.5,12 3,14",
  "!": "4,0 4,8|4,11",
  "?": "1,3 3,0 6,0 7,2 7,4 5,6 4,7 4,8|4,11",
  "'": "3,0 4,2",
  '"': "2,0 3,2|5,0 6,2",
  "-": "1,7 7,7",
  "–": "0,7 8,7",
  "—": "0,7 8,7",
  "−": "1,7 7,7",
  "/": "7,0 1,12",
  "(": "5,0 3,2 3,10 5,12",
  ")": "3,0 5,2 5,10 3,12",
  "%": "7,0 1,12|1,1 3,1 3,3 1,3 1,1|5,9 7,9 7,11 5,11 5,9",
  $: "4,-1 4,13|7,2 5,0 2,0 1,2 1,4 3,6 5,6 7,7 7,10 5,12 2,12 1,10",
  "£": "6,0 1,0 1,6 1,10 3,12 6,12|1,5 5,5|1,8 5,8",
  "&": "7,3 5,0 2,0 1,2 1,4 3,6 6,8 7,10 7,11 5,12 2,12 1,10 1,8 3,6",
  "·": "4,5",
  "+": "4,3 4,9|1,6 7,6",
  "×": "1,4 7,10|7,4 1,10",
  "~": "0,8 2,6 4,6 6,8 8,8",
  "=": "1,5 7,5|1,8 7,8",
  "ö": "2,4 5,4 6,6 6,10 5,12 2,12 1,10 1,6 2,4|2.5,1|5.5,1",
  "é": "1,8 6,8|6,8 6,6 5,4 3,4 1,6 1,8 1,10 2,12 4,12 6,11 6,9|4.5,0 6,2",
  "’": "3,0 4,2",
  "‘": "3,0 4,2",
  "“": "2,0 3,2|5,0 6,2",
  "”": "2,0 3,2|5,0 6,2",
};

// Advance width in grid units (default 9).
const WIDTHS: Record<string, number> = {
  " ": 5,
  i: 5, j: 5, l: 5, ".": 5, ",": 5, ":": 5, ";": 5, "!": 5, "'": 5, "’": 5, "‘": 5,
  "·": 5, "(": 5, ")": 5, "/": 7, "1": 7, f: 6, r: 6, t: 6,
  M: 11, W: 11, m: 11, w: 10, "—": 12, "%": 11, "–": 9, "-": 7, "−": 7,
};

function glyphAdvance(ch: string): number {
  return WIDTHS[ch] ?? 9;
}

interface TextOpts {
  bold?: boolean;
  serif?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  tracking?: number; // extra px between glyphs
}

function strokeWidthFor(size: number, bold?: boolean): number {
  // Small text (<15px) gets a heavier stroke so it reads as normal printed
  // text instead of thin wobbly lines; large display text (masthead, 40px)
  // keeps its original weight exactly.
  if (size < 15) {
    let w = Math.max(1.15, size * 0.135);
    if (bold) w *= 1.45;
    return w;
  }
  let w = Math.max(0.9, size * 0.11);
  if (bold) w *= 1.55;
  return w;
}

// Draw one glyph at (gx, baselineY) in px; size = cap height in px.
function drawGlyph(ch: string, gx: number, baseY: number, size: number, c: RGB, o: TextOpts): void {
  const def = GLYPHS[ch];
  if (!def) return;
  const s = size / 12; // px per grid unit
  const wdt = strokeWidthFor(size, o.bold);
  const slant = o.italic ? 0.16 : 0;
  // italic shear: shift x right as y rises above baseline
  const px2 = (u: number, v: number): [number, number] => {
    const y = baseY - (12 - v) * s;
    return [gx + u * s + (baseY - y) * slant, y];
  };
  const SERIF_LEVELS = [0, 4, 12, 16];
  for (const stroke of def.split("|")) {
    const pts = stroke
      .trim()
      .split(/\s+/)
      .map((p) => {
        const [u, v] = p.split(",").map(Number);
        return { u, v };
      });
    if (pts.length === 0) continue;
    if (pts.length === 1) {
      const [x, y] = px2(pts[0].u, pts[0].v);
      fillCircle(x, y, Math.max(1.1, wdt * 1.05), c);
      continue;
    }
    const closed = pts[0].u === pts[pts.length - 1].u && pts[0].v === pts[pts.length - 1].v;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = px2(pts[i].u, pts[i].v);
      const [x1, y1] = px2(pts[i + 1].u, pts[i + 1].v);
      thickLine(x0, y0, x1, y1, c, wdt);
    }
    // Serif ticks at steep stroke ends resting on a key level.
    if (o.serif && !closed) {
      const ends: Array<{ p: { u: number; v: number }; q: { u: number; v: number } }> = [
        { p: pts[0], q: pts[1] },
        { p: pts[pts.length - 1], q: pts[pts.length - 2] },
      ];
      for (const e of ends) {
        const du = e.q.u - e.p.u;
        const dv = e.q.v - e.p.v;
        if (Math.abs(dv) >= 2 * Math.abs(du) && SERIF_LEVELS.some((lv) => Math.abs(e.p.v - lv) < 0.6)) {
          const [x, y] = px2(e.p.u, e.p.v);
          const half = 1.15 * s;
          thickLine(x - half, y, x + half, y, c, wdt);
        }
      }
    }
  }
}

function textWidth(s: string, size: number, o: TextOpts = {}): number {
  const sc = size / 12;
  let w = 0;
  for (const ch of s) w += glyphAdvance(ch) * sc + (o.tracking ?? 0);
  return w - (o.tracking ?? 0);
}

function drawText(x: number, baseY: number, s: string, size: number, c: RGB, o: TextOpts = {}): void {
  const sc = size / 12;
  let cx = x;
  if (o.align === "center") cx = x - textWidth(s, size, o) / 2;
  else if (o.align === "right") cx = x - textWidth(s, size, o);
  for (const ch of s) {
    drawGlyph(ch, cx, baseY, size, c, o);
    cx += glyphAdvance(ch) * sc + (o.tracking ?? 0);
  }
}

// Word-wrap plain text to maxWidth px. Returns lines (no trailing spaces).
function wrapText(s: string, size: number, maxWidth: number, o: TextOpts = {}): string[] {
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(trial, size, o) <= maxWidth || !cur) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------- art helpers
const SKY: RGB = hex("#bcd3dd");
const SKY2: RGB = hex("#dfe9ec");
const SEA: RGB = hex("#2e5f7a");
const SEA2: RGB = hex("#3f7a99");
const SAND: RGB = hex("#d9c9a3");
const WOOD: RGB = hex("#6b4a2f");
const DARK: RGB = hex("#33302a");
const SMOKE: RGB = hex("#8d8a82");
const FIRE: RGB = hex("#e0641f");
const FIRE2: RGB = hex("#f2a41f");
const GREEN: RGB = hex("#3e7a3a");
const GREEN2: RGB = hex("#5da24f");

// Small flag: pole + 3 vertical stripes (used inside scenes, not as icons).
function flag(x: number, y: number, h: number, c1: RGB, c2: RGB, c3: RGB): void {
  line(x, y, x, y + h, DARK);
  const w = Math.max(8, h * 0.55);
  fillRect(x + 1, y, w / 3, h * 0.55, c1);
  fillRect(x + 1 + w / 3, y, w / 3, h * 0.55, c2);
  fillRect(x + 1 + (2 * w) / 3, y, w / 3, h * 0.55, c3);
}

function flame(x: number, y: number, w: number, h: number): void {
  fillPoly(
    [
      [x, y + h],
      [x + w * 0.15, y + h * 0.45],
      [x + w * 0.35, y + h * 0.6],
      [x + w * 0.5, y],
      [x + w * 0.65, y + h * 0.55],
      [x + w * 0.85, y + h * 0.4],
      [x + w, y + h],
    ],
    FIRE,
  );
  fillPoly(
    [
      [x + w * 0.25, y + h],
      [x + w * 0.4, y + h * 0.55],
      [x + w * 0.5, y + h * 0.2],
      [x + w * 0.62, y + h * 0.55],
      [x + w * 0.75, y + h],
    ],
    FIRE2,
  );
}

function smokePuff(x: number, y: number, r: number): void {
  fillCircle(x, y, r, SMOKE);
  fillCircle(x + r * 0.7, y - r * 0.4, r * 0.75, hex("#a39f94"));
  fillCircle(x - r * 0.7, y - r * 0.3, r * 0.6, hex("#7c7870"));
}

function waves(x: number, y: number, w: number, rows: number, c: RGB): void {
  for (let i = 0; i < rows; i++) {
    const yy = y + i * 7 + 3;
    for (let xx = x + 4; xx < x + w - 4; xx += 14) {
      line(xx, yy, xx + 7, yy, c);
    }
  }
}

// ------------------------------------------------------------ lead scenes
function sceneCOP31(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SAND);
  // windows with sea + mountains
  fillRect(x + 14, y + 8, w - 28, 34, SKY);
  fillPoly(
    [
      [x + 14, y + 42],
      [x + 90, y + 18],
      [x + 150, y + 42],
    ],
    hex("#7a8a7a"),
  );
  fillPoly(
    [
      [x + 130, y + 42],
      [x + 210, y + 14],
      [x + w - 14, y + 42],
    ],
    hex("#6b7d6b"),
  );
  fillRect(x + 14, y + 34, w - 28, 8, SEA);
  // hall wall + floor
  fillRect(x, y + 46, w, h - 46, hex("#c9b285"));
  fillRect(x, y + h - 12, w, 12, hex("#a98f63"));
  // curved desk rows
  for (let r = 0; r < 3; r++) {
    const yy = y + 52 + r * 11;
    fillRect(x + 30 + r * 12, yy, w - 60 - r * 24, 6, WOOD);
  }
  // delegate flags along desks
  const flagCols: RGB[] = [RED, NAVY, GREEN, GOLD, hex("#7a4a7a"), hex("#c25e1e")];
  for (let i = 0; i < 12; i++) {
    const fx = x + 40 + i * ((w - 80) / 11);
    fillRect(fx, y + 47, 3, 6, flagCols[i % flagCols.length]);
  }
  // podium with speaker
  fillRect(x + w - 78, y + 62, 34, h - 62 - 12, hex("#5d3f27"));
  fillRect(x + w - 84, y + 58, 46, 5, hex("#4a3220"));
  fillCircle(x + w - 61, y + 52, 5, DARK);
  fillPoly(
    [
      [x + w - 68, y + 58],
      [x + w - 54, y + 58],
      [x + w - 50, y + 66],
      [x + w - 72, y + 66],
    ],
    DARK,
  );
  // empty chair at the head table (no deal)
  fillRect(x + 22, y + 66, 26, 18, hex("#4a3a28"));
  fillRect(x + 26, y + 60, 18, 7, hex("#3a2c1e"));
}

function sceneMerkury(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY2);
  fillCircle(x + w - 52, y + 20, 13, FIRE2);
  fillRect(x, y + 52, w, h - 52, SEA);
  waves(x, y + 56, w, 5, SEA2);
  // listing warship
  fillPoly(
    [
      [x + 40, y + 62],
      [x + 250, y + 74],
      [x + 246, y + 88],
      [x + 48, y + 84],
    ],
    hex("#3a3f45"),
  );
  fillPoly(
    [
      [x + 60, y + 62],
      [x + 96, y + 64],
      [x + 92, y + 50],
      [x + 64, y + 48],
    ],
    hex("#4a5058"),
  );
  line(x + 82, y + 48, x + 82, y + 30, hex("#2c3036"));
  // helicopter on deck, burning
  fillPoly(
    [
      [x + 150, y + 60],
      [x + 176, y + 58],
      [x + 180, y + 64],
      [x + 152, y + 66],
    ],
    hex("#2c3036"),
  );
  flame(x + 168, y + 34, 22, 26);
  flame(x + 96, y + 40, 16, 18);
  smokePuff(x + 120, y + 26, 12);
  smokePuff(x + 190, y + 18, 14);
  // sea drones approaching
  for (const dx of [30, 268, 292]) {
    fillPoly(
      [
        [x + dx, y + 86],
        [x + dx + 22, y + 86],
        [x + dx + 18, y + 92],
        [x + dx + 4, y + 92],
      ],
      hex("#5a6068"),
    );
    line(x + dx + 11, y + 86, x + dx + 11, y + 80, hex("#2c3036"));
  }
  waves(x, y + 90, w, 1, hex("#6fa3bd"));
}

function sceneDymer(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, hex("#e3cfa5"));
  fillCircle(x + 34, y + 20, 11, FIRE2);
  // damaged five-storey block, jagged broken top
  fillPoly(
    [
      [x + 96, y + 96],
      [x + 96, y + 26],
      [x + 130, y + 14],
      [x + 158, y + 28],
      [x + 190, y + 18],
      [x + 224, y + 30],
      [x + 224, y + 96],
    ],
    hex("#8a7f74"),
  );
  for (let f = 0; f < 4; f++) {
    for (let c = 0; c < 4; c++) {
      const wx = x + 106 + c * 30;
      const wy = y + 38 + f * 16;
      fillRect(wx, wy, 16, 10, f === 0 && c === 2 ? hex("#3a2c1e") : hex("#f2e3b8"));
    }
  }
  // fire + smoke from the break
  flame(x + 148, y + 8, 26, 18);
  smokePuff(x + 176, y + 10, 12);
  smokePuff(x + 210, y + 6, 9);
  // neighbouring block, intact
  fillRect(x + 238, y + 46, 56, 50, hex("#a89a86"));
  for (let f = 0; f < 3; f++)
    for (let c = 0; c < 2; c++) fillRect(x + 246 + c * 26, y + 54 + f * 14, 14, 9, hex("#f2e3b8"));
  // rescue ladder + floodlight
  line(x + 60, y + 96, x + 108, y + 40, hex("#c25e1e"));
  line(x + 66, y + 96, x + 114, y + 40, hex("#c25e1e"));
  for (let i = 0; i < 6; i++) line(x + 62 + i * 8, y + 90 - i * 9, x + 70 + i * 8, y + 90 - i * 9, hex("#c25e1e"));
  fillCircle(x + 52, y + 92, 4, DARK);
  fillCircle(x + 46, y + 96, 4, DARK);
  fillRect(x + 268, y + 88, 10, 8, DARK);
  fillPoly(
    [
      [x + 268, y + 88],
      [x + 300, y + 70],
      [x + 300, y + 96],
    ],
    hex("#f2e3b8"),
  );
}

// ------------------------------------------------------------ small scenes
function sceneCapitol(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h - 10, w, 10, GREEN);
  fillRect(x + 8, y + 34, w - 16, 18, hex("#e8e2d2"));
  fillPoly(
    [
      [x + w / 2 - 14, y + 34],
      [x + w / 2 + 14, y + 34],
      [x + w / 2 + 9, y + 20],
      [x + w / 2 - 9, y + 20],
    ],
    hex("#f4efe0"),
  );
  fillCircle(x + w / 2, y + 20, 9, hex("#f4efe0"));
  fillRect(x + w / 2 - 1, y + 8, 2, 6, DARK);
  fillRect(x + 16, y + 40, 3, 12, hex("#c9bfa4"));
  fillRect(x + w - 19, y + 40, 3, 12, hex("#c9bfa4"));
  fillRect(x + w / 2 - 8, y + 44, 16, 8, hex("#c9bfa4"));
  flag(x + w - 14, y + 10, 16, RED, WHITE, NAVY);
}

function sceneTokyo(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, hex("#20242c"));
  fillRect(x + 4, y + 4, w - 8, 16, hex("#2c313c"));
  drawText(x + 8, y + 16, "NIKKEI", 8, hex("#d8d2c0"), { bold: true });
  drawText(x + w - 6, y + 16, "-5.06%", 8, hex("#e05252"), { bold: true, align: "right" });
  // candlesticks falling
  const bars: Array<[number, number, number]> = [
    [10, 26, 12],
    [20, 30, 10],
    [30, 36, 12],
    [40, 42, 10],
    [50, 48, 12],
  ];
  for (const [bx, by, bh] of bars) fillRect(x + bx, y + by, 6, bh, hex("#e05252"));
  fillPoly(
    [
      [x + 8, y + 24],
      [x + w - 8, y + 24],
      [x + w - 8, y + 30],
      [x + 8, y + 30],
    ],
    hex("#e05252"),
  );
  fillPoly(
    [
      [x + w - 14, y + 30],
      [x + w - 4, y + 30],
      [x + w - 9, y + 44],
    ],
    hex("#e05252"),
  );
}

function sceneFactory(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, hex("#e8d9b8"));
  fillRect(x, y + h - 8, w, 8, hex("#b09a72"));
  // sawtooth factory
  fillPoly(
    [
      [x + 4, y + 34],
      [x + 4, y + h - 8],
      [x + w - 4, y + h - 8],
      [x + w - 4, y + 34],
      [x + w - 16, y + 24],
      [x + w - 28, y + 34],
      [x + w - 40, y + 24],
      [x + w - 52, y + 34],
      [x + 16, y + 24],
    ],
    hex("#7a6a55"),
  );
  fillRect(x + 8, y + 40, 10, 8, hex("#f2e3b8"));
  fillRect(x + 24, y + 40, 10, 8, hex("#f2e3b8"));
  fillRect(x + 40, y + 40, 10, 8, hex("#f2e3b8"));
  flame(x + 10, y + 18, 18, 18);
  flame(x + 34, y + 22, 14, 14);
  smokePuff(x + 20, y + 12, 8);
  smokePuff(x + 44, y + 8, 9);
  // chimney
  fillRect(x + w - 12, y + 10, 6, 26, hex("#5a4f42"));
}

function sceneTankers(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY2);
  fillRect(x, y + 34, w, h - 34, SEA);
  waves(x, y + 38, w, 3, SEA2);
  // tanker 1
  fillPoly(
    [
      [x + 4, y + 40],
      [x + 34, y + 40],
      [x + 30, y + 48],
      [x + 8, y + 48],
    ],
    hex("#3a3f45"),
  );
  fillRect(x + 24, y + 32, 8, 8, hex("#4a5058"));
  flame(x + 12, y + 26, 14, 14);
  smokePuff(x + 18, y + 18, 8);
  // tanker 2
  fillPoly(
    [
      [x + 30, y + 50],
      [x + 58, y + 50],
      [x + 54, y + 58],
      [x + 34, y + 58],
    ],
    hex("#5a3a2e"),
  );
  fillRect(x + 48, y + 42, 8, 8, hex("#6b4a3a"));
  flame(x + 38, y + 36, 14, 14);
  smokePuff(x + 44, y + 28, 8);
}

function sceneShip(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + 40, w, h - 40, SEA);
  waves(x, y + 44, w, 2, SEA2);
  // rising bars (exports)
  const bh = [10, 16, 24, 34];
  for (let i = 0; i < 4; i++) fillRect(x + 6 + i * 8, y + 34 - bh[i], 5, bh[i], TEAL);
  // container ship
  fillPoly(
    [
      [x + 22, y + 44],
      [x + 58, y + 44],
      [x + 54, y + 54],
      [x + 26, y + 54],
    ],
    hex("#7d2e1e"),
  );
  const cols: RGB[] = [RED, GOLD, NAVY, GREEN, hex("#c25e1e")];
  for (let i = 0; i < 5; i++) fillRect(x + 25 + i * 6, y + 36, 5, 8, cols[i]);
  for (let i = 0; i < 3; i++) fillRect(x + 28 + i * 6, y + 28, 5, 8, cols[(i + 2) % 5]);
  fillRect(x + 54, y + 34, 4, 10, hex("#e8e2d2"));
}

function sceneNATO(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, hex("#d8cdb2"));
  fillRect(x, y + h - 12, w, 12, hex("#a98f63"));
  // round table
  fillPoly(
    [
      [x + 12, y + 34],
      [x + w - 12, y + 34],
      [x + w - 8, y + 42],
      [x + 12, y + 42],
    ],
    WOOD,
  );
  fillRect(x + 18, y + 42, w - 36, 4, hex("#4a3220"));
  // chairs + delegates
  for (let i = 0; i < 5; i++) {
    const cx = x + 10 + i * ((w - 20) / 4);
    fillCircle(cx, y + 26, 5, hex("#3a3f45"));
    fillRect(cx - 6, y + 30, 12, 5, hex("#3a3f45"));
  }
  // flags behind
  const cols: RGB[] = [RED, NAVY, GREEN, GOLD, hex("#7a4a7a")];
  for (let i = 0; i < 5; i++) {
    const fx = x + 8 + i * ((w - 16) / 4);
    fillRect(fx, y + 6, 3, 8, cols[i]);
  }
}

function sceneStadium(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY2);
  fillRect(x, y + 30, w, h - 30, GREEN);
  fillRect(x, y + 30, w, 4, hex("#e8e2d2"));
  // stands
  fillRect(x, y + 4, w, 12, hex("#8a2a2a"));
  for (let i = 0; i < 8; i++) fillRect(x + 4 + i * 7, y + 8, 3, 5, hex("#e8e2d2"));
  // pitch lines
  line(x + 6, y + 34, x + 6, y + h - 4, hex("#e8e2d2"));
  line(x + w - 6, y + 34, x + w - 6, y + h - 4, hex("#e8e2d2"));
  circleOutline(x + w / 2, y + 46, 9, hex("#e8e2d2"));
  // scoreboard
  fillRect(x + w / 2 - 16, y + 16, 32, 12, DARK);
  drawText(x + w / 2, y + 26, "4-0", 9, WHITE, { bold: true, align: "center" });
  // players
  fillCircle(x + 14, y + 44, 3, RED);
  fillCircle(x + 22, y + 52, 3, WHITE);
  fillCircle(x + w - 16, y + 48, 3, RED);
  fillCircle(x + w - 24, y + 56, 3, WHITE);
}

function sceneRefinery(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, hex("#e8d3a8"));
  fillRect(x, y + h - 8, w, 8, hex("#8a7a5e"));
  // towers
  fillRect(x + 8, y + 18, 8, 36, hex("#5a5148"));
  fillRect(x + 22, y + 26, 10, 28, hex("#6b5f52"));
  fillRect(x + 38, y + 14, 7, 40, hex("#4a4238"));
  // pipes
  line(x + 16, y + 30, x + 38, y + 30, hex("#3a332c"));
  line(x + 27, y + 40, x + 45, y + 40, hex("#3a332c"));
  // storage tanks
  fillPoly(
    [
      [x + 46, y + 54],
      [x + 46, y + 42],
      [x + 52, y + 38],
      [x + 58, y + 42],
      [x + 58, y + 54],
    ],
    hex("#7a6a55"),
  );
  flame(x + 40, y + 6, 14, 12);
  flame(x + 10, y + 10, 12, 10);
  smokePuff(x + 46, y + 8, 7);
  smokePuff(x + 16, y + 4, 6);
}

function sceneWhiteHouse(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h - 10, w, 10, GREEN);
  fillRect(x + 10, y + 30, w - 20, 22, hex("#f4efe0"));
  fillPoly(
    [
      [x + 10, y + 30],
      [x + w - 10, y + 30],
      [x + w / 2, y + 20],
    ],
    hex("#e8e2d2"),
  );
  for (let i = 0; i < 4; i++) fillRect(x + 16 + i * 10, y + 34, 3, 18, hex("#d8d2c0"));
  fillRect(x + w / 2 - 5, y + 44, 10, 8, hex("#8a7a5e"));
  flag(x + w - 12, y + 12, 14, RED, WHITE, NAVY);
  // podium
  fillRect(x + 6, y + 44, 8, 8, WOOD);
}

function sceneTaipei(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h - 8, w, 8, hex("#8a7a5e"));
  // Taipei 101 tapering stack
  let yy = y + h - 8;
  for (let i = 0; i < 7; i++) {
    const ww = 26 - i * 2.5;
    yy -= 6;
    fillRect(x + w / 2 - ww / 2, yy, ww, 6, i % 2 ? hex("#3f5a6b") : hex("#4a6a7d"));
  }
  line(x + w / 2, y + 2, x + w / 2, yy, hex("#2c3a44"));
  // ticker swing line
  line(x + 4, y + 40, x + 14, y + 30, hex("#e05252"));
  line(x + 14, y + 30, x + 24, y + 46, hex("#e05252"));
  line(x + 24, y + 46, x + 34, y + 36, GREEN);
  line(x + 34, y + 36, x + w - 6, y + 26, GREEN);
}

function scenePalace(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h - 10, w, 10, GREEN);
  fillRect(x + 8, y + 32, w - 16, 20, hex("#e8dcc0"));
  fillPoly(
    [
      [x + 8, y + 32],
      [x + w - 8, y + 32],
      [x + w / 2, y + 22],
    ],
    hex("#d8c9a3"),
  );
  for (let i = 0; i < 4; i++) fillRect(x + 14 + i * 11, y + 36, 3, 16, hex("#c9bfa4"));
  fillRect(x + w / 2 - 5, y + 44, 10, 8, hex("#8a7a5e"));
  flag(x + w - 12, y + 12, 14, NAVY, WHITE, RED);
  flag(x + 6, y + 12, 14, NAVY, WHITE, RED);
}

function sceneDelhi(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h - 10, w, 10, GREEN);
  // Rashtrapati Bhavan dome
  fillRect(x + 8, y + 36, w - 16, 16, hex("#d8b98a"));
  fillCircle(x + w / 2, y + 36, 12, hex("#c9a86a"));
  fillRect(x + w / 2 - 1, y + 20, 2, 6, DARK);
  for (let i = 0; i < 3; i++) fillRect(x + 16 + i * 14, y + 40, 4, 12, hex("#b89a6a"));
  // two flags: India + Nepal
  flag(x + 8, y + 16, 14, hex("#e07a1e"), WHITE, GREEN);
  flag(x + w - 20, y + 16, 14, hex("#dc143c"), WHITE, NAVY);
  // red carpet
  fillRect(x + w / 2 - 6, y + 52, 12, h - 52 - 10, RED);
}

// ------------------------------------------------------------------- map
const MAP_X = 24;
const MAP_Y = 610;
const MAP_W = 976;
const MAP_H = 126;

function lonToX(lon: number): number {
  return MAP_X + ((lon + 170) / 355) * MAP_W;
}
function latToY(lat: number): number {
  return MAP_Y + ((82 - lat) / 140) * MAP_H;
}

const LAND: RGB = hex("#d9c9a3");
const LAND_LINE: RGB = hex("#b39d72");
const OCEAN: RGB = hex("#dce6e2");

const CONTINENTS: Array<Array<[number, number]>> = [
  // Eurasia
  [
    [-10, 36], [-9, 43], [-2, 48], [-5, 50], [0, 51], [3, 53], [8, 57], [10, 59],
    [5, 60], [5, 62], [12, 65], [18, 69], [25, 71], [30, 70], [40, 68], [50, 68],
    [60, 69], [70, 72], [80, 73], [90, 75], [100, 76], [110, 74], [120, 73],
    [130, 72], [140, 72], [150, 70], [160, 65], [170, 66], [178, 65], [170, 60],
    [162, 58], [158, 52], [150, 60], [142, 55], [140, 50], [135, 45], [130, 40],
    [127, 35], [122, 30], [120, 25], [115, 20], [110, 10], [105, 5], [100, 8],
    [95, 15], [90, 22], [85, 20], [80, 15], [77, 8], [75, 15], [70, 20],
    [66, 25], [60, 25], [57, 26], [52, 28], [50, 30], [48, 30], [44, 29],
    [40, 32], [36, 36], [30, 36], [27, 37], [23, 36], [19, 40], [12, 44],
    [8, 44], [3, 43], [-2, 37],
  ],
  // Africa
  [
    [-6, 35], [0, 36], [10, 37], [11, 34], [20, 32], [32, 31], [35, 28], [37, 22],
    [40, 15], [43, 12], [48, 11], [51, 10], [46, 5], [42, 0], [40, -5], [40, -12],
    [35, -18], [32, -25], [28, -32], [20, -35], [16, -28], [12, -18], [9, -2],
    [9, 4], [0, 5], [-8, 4], [-15, 8], [-17, 15], [-16, 22], [-10, 30],
  ],
  // North America
  [
    [-168, 66], [-140, 70], [-125, 72], [-110, 73], [-95, 80], [-85, 76], [-75, 73],
    [-65, 60], [-55, 47], [-60, 45], [-70, 42], [-75, 35], [-80, 25], [-85, 30],
    [-90, 21], [-95, 19], [-100, 16], [-105, 20], [-110, 23], [-115, 30],
    [-120, 34], [-125, 40], [-125, 48], [-135, 58], [-150, 60], [-165, 60],
  ],
  // South America
  [
    [-80, 10], [-75, 5], [-70, 0], [-60, -5], [-50, -5], [-40, -10], [-35, -15],
    [-40, -22], [-48, -28], [-55, -35], [-65, -40], [-70, -50], [-73, -55],
    [-70, -45], [-75, -35], [-80, -25], [-80, -15], [-78, -5],
  ],
  // Australia
  [
    [114, -22], [114, -30], [115, -35], [120, -34], [125, -32], [130, -32],
    [135, -35], [140, -38], [145, -38], [150, -37], [153, -27], [150, -22],
    [146, -19], [142, -15], [142, -11], [137, -12], [135, -15], [130, -13],
    [126, -14], [122, -17], [118, -20],
  ],
  // Greenland
  [
    [-45, 60], [-40, 64], [-30, 68], [-22, 70], [-20, 74], [-30, 76], [-45, 78],
    [-58, 76], [-55, 70], [-52, 64],
  ],
  // Japan
  [
    [130, 31], [132, 33], [135, 34], [137, 35], [139, 38], [141, 41], [143, 44],
    [141, 45], [140, 40], [138, 37], [135, 35], [132, 33],
  ],
  // Indonesia
  [
    [95, 5], [100, 0], [105, -5], [110, -7], [115, -8], [120, -9], [125, -8],
    [130, -5], [135, -3], [140, -4], [138, -8], [130, -10], [120, -10],
    [110, -8], [100, -5], [95, 0],
  ],
  // Britain
  [[-5, 50], [-3, 53], [-5, 56], [-3, 58], [-1, 57], [0, 53]],
];

interface MapMark {
  n: number;
  lon: number;
  lat: number;
  lead?: boolean;
  dx?: number;
  dy?: number;
}

// Pins 1-15 (illustrated stories). 4 and 12 are both Washington: 12 is offset.
const PINS: MapMark[] = [
  { n: 1, lon: 30.7, lat: 36.9, lead: true, dx: 14, dy: 10 }, // Antalya, offset down-right (was touching Dymer pin 3)
  { n: 2, lon: 20.1, lat: 32.1, lead: true },
  { n: 3, lon: 30.3, lat: 50.8, lead: true },
  { n: 4, lon: -77.0, lat: 38.9 },
  { n: 5, lon: 139.7, lat: 35.7 },
  { n: 6, lon: 106.1, lat: -6.0 },
  { n: 7, lon: 56.5, lat: 26.5 },
  { n: 8, lon: 127.0, lat: 37.5 },
  { n: 9, lon: 21.0, lat: 52.2 },
  { n: 10, lon: -3.0, lat: 53.4 },
  { n: 11, lon: 50.0, lat: 56.0 },
  { n: 12, lon: -77.0, lat: 38.9, dx: 18, dy: 14 },
  { n: 13, lon: 121.6, lat: 25.0 },
  { n: 14, lon: 2.35, lat: 48.85, dx: 10, dy: -12 }, // Paris, offset up-right (was touching Liverpool pin 10)
  { n: 15, lon: 77.2, lat: 28.6 },
];

// Dots for briefs with a place (brief 30, Science, has none and is skipped).
const DOTS: MapMark[] = [
  { n: 16, lon: -84.4, lat: 33.7 },
  { n: 17, lon: 34.5, lat: 31.5, dx: 20, dy: 12 },
  { n: 18, lon: 127.0, lat: 37.5, dx: 12, dy: -12 },
  { n: 19, lon: -93.1, lat: 41.9 },
  { n: 20, lon: -108.5, lat: 25.6 },
  { n: 21, lon: 32.5, lat: 15.6 },
  { n: 22, lon: -47.9, lat: -15.8 },
  { n: 23, lon: 5.0, lat: 10.0 },
  { n: 24, lon: 28.7, lat: 7.3 },
  { n: 25, lon: -0.2, lat: 5.6 },
  { n: 26, lon: -79.0, lat: -3.0 },
  { n: 27, lon: 30.7, lat: 46.5, dx: 18, dy: 8 },
  { n: 28, lon: 30.5, lat: 50.45, dx: 16, dy: -8 },
  { n: 29, lon: 2.35, lat: 48.85, dx: -16, dy: 12 },
  { n: 31, lon: 17.1, lat: 48.15, dx: -3, dy: 7 },
  { n: 32, lon: -74.0, lat: 40.7, dx: 14, dy: -12 },
  { n: 33, lon: 4.35, lat: 50.85, dx: 12, dy: -14 },
  { n: 34, lon: -0.1, lat: 51.5, dx: -17, dy: -14 },
  { n: 35, lon: 28.2, lat: -25.9 },
  { n: 36, lon: 106.8, lat: -6.2, dx: 14, dy: 10 },
];

function drawMap(): void {
  drawText(24, 606, "THE WORLD — WHERE IT HAPPENED", 10, INK, { bold: true });
  fillRect(MAP_X, MAP_Y, MAP_W, MAP_H, OCEAN);
  rect(MAP_X, MAP_Y, MAP_W, MAP_H, LAND_LINE, 1);
  for (const cont of CONTINENTS) {
    const pts = cont.map(([lo, la]) => [lonToX(lo), latToY(la)] as [number, number]);
    fillPoly(pts, LAND);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      line(a[0], a[1], b[0], b[1], LAND_LINE);
    }
  }
  // graticule (light)
  for (let lo = -120; lo <= 120; lo += 60) line(lonToX(lo), MAP_Y, lonToX(lo), MAP_Y + MAP_H, hex("#c9d6d2"));
  for (let la = -40; la <= 60; la += 20) line(MAP_X, latToY(la), MAP_X + MAP_W, latToY(la), hex("#c9d6d2"));
  // dots first (under pins)
  for (const d of DOTS) {
    const tx = lonToX(d.lon);
    const ty = latToY(d.lat);
    const cx = tx + (d.dx ?? 0);
    const cy = ty + (d.dy ?? 0);
    if (d.dx || d.dy) {
      line(tx, ty, cx, cy, GREY);
      fillCircle(tx, ty, 1.6, GREY);
    }
    fillCircle(cx, cy, 3, GREY);
  }
  // numbered pins
  for (const p of PINS) {
    const tx = lonToX(p.lon);
    const ty = latToY(p.lat);
    const cx = tx + (p.dx ?? 0);
    const cy = ty + (p.dy ?? 0);
    if (p.dx || p.dy) {
      line(tx, ty, cx, cy, INK);
      fillCircle(tx, ty, 2, p.lead ? RED : NAVY);
    }
    const col = p.lead ? RED : NAVY;
    fillCircle(cx, cy, 7.5, col);
    circleOutline(cx, cy, 7.5, WHITE);
    drawText(cx, cy + 3, String(p.n), 8.5, WHITE, { bold: true, align: "center" });
  }
  // legend
  let lx = 24;
  const ly = 744;
  fillCircle(lx + 5, ly - 3, 5, RED);
  lx += 14;
  drawText(lx, ly, "lead story 1–3", 8.5, INK);
  lx += textWidth("lead story 1–3", 8.5) + 18;
  fillCircle(lx + 5, ly - 3, 5, NAVY);
  lx += 14;
  drawText(lx, ly, "illustrated story 4–15", 8.5, INK);
  lx += textWidth("illustrated story 4–15", 8.5) + 18;
  fillCircle(lx + 3, ly - 3, 3, GREY);
  lx += 10;
  drawText(lx, ly, "grey dot = brief 16–36", 8.5, INK);
}

// ------------------------------------------------------------- story data
interface Lead {
  n: number;
  headline: string;
  one: string;
  source: string;
  tag: string;
  scene: (x: number, y: number, w: number, h: number) => void;
}

const LEADS: Lead[] = [
  {
    n: 1,
    headline: "COP31 collapses with no climate deal",
    one: "UN talks end Sunday after a record two days of overtime — the longest COP ever.",
    source: "Reuters, CNN, BBC",
    tag: "CONFIRMED",
    scene: sceneCOP31,
  },
  {
    n: 2,
    headline: "Ukrainian sea drones sink Russian warship Merkury",
    one: "Zelenskyy: 7 maritime drones sank the 344-foot corvette at Benghazi while refuelling.",
    source: "CNN",
    tag: "REPORTED",
    scene: sceneMerkury,
  },
  {
    n: 3,
    headline: "Russian drone strike kills 11 in Dymer",
    one: "Strike on a five-storey block north of Kyiv; a boy, 7, pulled alive after 14 hours.",
    source: "AP, Ukrainian officials",
    tag: "CONFIRMED",
    scene: sceneDymer,
  },
];

interface Small {
  n: number;
  headline: string;
  one: string;
  source: string;
  tag: string;
  scene: (x: number, y: number, w: number, h: number) => void;
}

const SMALLS: Small[] = [
  { n: 4, headline: "Democrats clinch 258 House seats", one: "Largest House majority since 1992; Hubbard beats Foxx in a recount.", source: "AP", tag: "CONFIRMED", scene: sceneCapitol },
  { n: 5, headline: "Nikkei falls 5.06% as AI sell-off spreads", one: "Friday's close, reported Monday; Kospi −3.3% Monday; S&P futures +2.1%.", source: "Market wires", tag: "CONFIRMED", scene: sceneTokyo },
  { n: 6, headline: "24 dead in candy factory fire, ~30 missing", one: "Fire at PT Fonusa Agung Mulia in Cikande; search goes on in the wreckage.", source: "Reuters", tag: "CONFIRMED", scene: sceneFactory },
  { n: 7, headline: "Two tankers ablaze near Hormuz", one: "UKMTO reports mines hit two tankers; Bahrain accuses Iran; drone claim.", source: "UKMTO, Reuters", tag: "CLAIM", scene: sceneTankers },
  { n: 8, headline: "Korea's exports more than double in November", one: "Nov 1–20 exports $77.4bn, up 101.5%; chips $38.5bn, up 294%.", source: "Korea Customs", tag: "CONFIRMED", scene: sceneShip },
  { n: 9, headline: "NATO meets after missiles land in Poland", one: "Poland confirms three Kh-101s fell 20 Nov; NATO holds an emergency session.", source: "Polish prosecutors", tag: "CONFIRMED", scene: sceneNATO },
  { n: 10, headline: "Liverpool 4–0 Man Utd in Pochettino's debut", one: "Yoro sent off in the 8th minute; Szoboszlai, Wirtz, Ngumoha and Munoz score.", source: "Reuters", tag: "CONFIRMED", scene: sceneStadium },
  { n: 11, headline: "Ukraine drones hit three Russian oil sites", one: "Novoshakhtinsk, Perm and a Tatarstan pumping station struck; fires reported.", source: "Ukrainian General Staff", tag: "REPORTED", scene: sceneRefinery },
  { n: 12, headline: "Trump 'inclined' to resume Iran conflict", one: "If no deal by the New Year, Trump says; US hawks urge strikes.", source: "FT, Economic Times", tag: "REPORTED", scene: sceneWhiteHouse },
  { n: 13, headline: "Taiwan stocks swing 1,578 points in a day", one: "Shares fall nearly 591 points early, then rally; TSMC ends over 2% higher.", source: "Market wires", tag: "CONFIRMED", scene: sceneTaipei },
  { n: 14, headline: "French frontrunners question Ukraine aid", one: "Ahead of next spring's election, both frontrunners question continued aid.", source: "Wire reports", tag: "REPORTED", scene: scenePalace },
  { n: 15, headline: "Nepal PM Balen Shah welcomed by Modi", one: "Ceremonial welcome at Rashtrapati Bhavan; India 3rd in Lowy Asia Power Index.", source: "Wire reports", tag: "CONFIRMED", scene: sceneDelhi },
];

const BRIEFS: Array<[number, string]> = [
  [16, "Atlanta: Delta delays 1,600+ flights at its hub after a systems failure; outage resolved Monday. (FAA)"],
  [17, "Gaza: experts say the war left widespread contamination. (Wire reports)"],
  [18, "Seoul: education minister Choi Kyo-jin resigns over an AI-driven exam-cheating scandal. (Wire reports)"],
  [19, "Iowa: US Army to detonate unstable explosives despite a court order. (Wire reports)"],
  [20, "Sinaloa: FBI most-wanted 'El Chapo Isidro' (Fausto Isidro Meza Flores) captured in Guasave. (Wire reports)"],
  [21, "Khartoum: drone strikes kill five children in Khartoum and Omdurman. (Wire reports)"],
  [22, "Brasilia: Bolsonaro in intensive care, stable, with an abdominal obstruction; no discharge date. (Wire reports)"],
  [23, "Nigeria: vigilantes reportedly kill Fulani in Niger State villages; at least 35 dead in Wawa, counts unconfirmed. (Wire reports)"],
  [24, "South Sudan: 21 killed in a Saturday-night raid on a Tonj East cattle camp. (Wire reports)"],
  [25, "Ghana: opens a voluntary buyback of up to $2.4bn of bonds maturing Feb 2027. (Wire reports)"],
  [26, "Ecuador: alleged Los Lobos leader Sayayin arrested in the south. (Wire reports)"],
  [27, "Odesa: schools go remote 23–27 Nov after strikes wreck the power grid. (Wire reports)"],
  [28, "Kyiv: Russian drone debris falls on school grounds and a warehouse. (Wire reports)"],
  [29, "Paris: Le Pen declines Zelenskyy's invitation to Ukraine; will meet in Paris or Brussels. (Wire reports)"],
  [30, "Science: Lean and Mathlib confirm Levent Alpöge's Riemann Hypothesis proof is correct. (Wire reports)"],
  [31, "Bratislava: Slovakia rejects contributing to a new €45bn EU loan for Ukraine. (Wire reports)"],
  [32, "United Nations: Britain, France and China block Nusseibeh's bid for the UN top job. (Wire reports)"],
  [33, "Brussels: Belgian airports shut Monday as a national anti-austerity strike grounds flights. (Wire reports)"],
  [34, "London: Titanic survivor's diamond ring sells for £150,000 at UK auction. (Wire reports)"],
  [35, "Centurion: rain delays the toss as South Africa v Bangladesh 2nd Test starts; Markram captains, South Africa lead the series 1–0 and top the Test table (75.00%). (Cricbuzz/ICC)"],
  [36, "Jakarta: Indonesia seizes a ship carrying 405 tonnes of sodium perchlorate, a rocket-propellant chemical, bound from China to Bangladesh. (Wire reports)"],
];

const DATE_CHECK =
  "DATE CHECK — MID-DAY EDITION: wires as of about 09:15 UTC, Monday 23 November 2026. " +
  "Not repeated from Sunday's edition: the Sparta II Baltic ship fire, the Peru 6.8 quake, " +
  "Eisenkot's mandate ceremony, Verstappen's Las Vegas pole, England's 37–12 rugby win, " +
  "Arsenal 2–2 and Leeds 4–1 Chelsea. Left out as earlier news: Korea crossing $1tn in " +
  "exports (19 Nov; Monday's news is the Nov 1–20 customs data). New on Monday: Lean and " +
  "Mathlib confirm the Riemann proof (brief 30). Still to come at press time: the rest of " +
  "Monday — NATO's session outcome, Wall Street's open, the Centurion toss. Played Sunday, " +
  "led Monday: Liverpool 4–0 Man Utd.";

const FOOTER =
  "Every story here happened, or was first reported, on Monday 23 November 2026 (UTC), or is a " +
  "weekend outcome as Monday's wires first reported it. Sources named beside each story — original drawings.";

// ------------------------------------------------------------------ layout
const M = 24;
const CW = W - 2 * M; // 976

function tagColor(tag: string): RGB {
  if (tag === "CONFIRMED") return hex("#2e6b34");
  if (tag === "REPORTED") return hex("#8a6d00");
  return RED; // CLAIM
}

function drawTag(xRight: number, baseY: number, tag: string): void {
  const tw = textWidth(tag, 7.5, { bold: true });
  const bw = tw + 10;
  const bh = 13;
  fillRect(xRight - bw, baseY - bh + 3, bw, bh, tagColor(tag));
  drawText(xRight - bw / 2, baseY, tag, 7.5, WHITE, { bold: true, align: "center" });
}

function render(): void {
  fillAll(PAPER);

  // ---- kicker bar
  fillRect(M, 8, CW, 26, RED);
  drawText(M + 10, 26, "THE WORLD IN ONE DAY — MID-DAY EDITION", 11, WHITE, { bold: true });
  drawText(W - M - 10, 26, "36 STORIES · 7 REGIONS · MONDAY 23 NOVEMBER 2026", 11, WHITE, {
    bold: true,
    align: "right",
  });

  // ---- masthead
  line(M, 40, W - M, 40, INK);
  drawText(W / 2, 80, "MONDAY 23 NOVEMBER 2026", 40, INK, { bold: true, serif: true, align: "center" });
  line(M, 88, W - M, 88, INK);

  // ---- sub-deck
  drawText(
    W / 2,
    106,
    "COP31 collapses in Antalya — Russian warship sunk off Libya — Dymer strike kills 11",
    14,
    DARKRED,
    { serif: true, italic: true, align: "center" },
  );

  // ---- numbers strip
  line(M, 114, W - M, 114, INK);
  const nums: Array<[string, string, RGB]> = [
    ["258", "Democrats' House seats", INK],
    ["−5.06%", "Nikkei fall, Friday's close", RED],
    ["11", "killed in Dymer strike", INK],
    ["24", "dead in Banten factory fire", INK],
    ["$77.4bn", "Korea Nov 1–20 exports", INK],
    ["7", "sea drones that sank the Merkury", INK],
  ];
  const cellW = CW / 6;
  nums.forEach(([num, label, col], i) => {
    const cx = M + cellW * i + cellW / 2;
    if (i > 0) line(M + cellW * i, 118, M + cellW * i, 166, hex("#c9bfa4"));
    drawText(cx, 142, num, 24, col, { bold: true, align: "center" });
    const ll = wrapText(label, 8, cellW - 12);
    ll.forEach((ln, j) => drawText(cx, 154 + j * 10, ln, 8, GREY, { align: "center" }));
  });
  line(M, 170, W - M, 170, INK);

  // ---- UTC timeline (two rows, short labels)
  drawText(M, 184, "UTC TIMELINE — MONDAY 23 NOVEMBER", 9, INK, { bold: true });
  const beats: Array<[string, string]> = [
    ["00:53", "Korea customs data out"],
    ["02:22", "Ukraine hits 3 Russian oil sites"],
    ["06:27", "Dymer toll reaches 11"],
    ["07:28", "Russia's 153-drone attack reported"],
    ["07:48", "Banten toll confirmed"],
    ["09:15", "Press time — this edition's cut-off"],
  ];
  beats.forEach(([t, label], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const bx = M + col * (CW / 3);
    const by = 198 + row * 12;
    drawText(bx, by, t, 9.5, RED, { bold: true });
    drawText(bx + textWidth(t, 9.5, { bold: true }) + 6, by, label, 9.5, INK);
  });

  // ---- 3 lead panels (art on top, headline in a solid cream band below)
  const leadW = (CW - 24) / 3;
  LEADS.forEach((lead, i) => {
    const x = M + i * (leadW + 12);
    lead.scene(x, 218, leadW, 96);
    rect(x, 218, leadW, 96, hex("#c9bfa4"), 1);
    // solid cream band, clear of the art (82px tall so the two headline
    // lines, two one-liner lines and the source line all have real air
    // between them; band bottom meets the small-stories row at y=396)
    fillRect(x, 314, leadW, 82, PAPER);
    const hl = wrapText(lead.headline, 14.5, leadW - 8, { bold: true, serif: true });
    hl.forEach((ln, j) => drawText(x + 4, 330 + j * 19, ln, 14.5, INK, { bold: true, serif: true }));
    const ol = wrapText(lead.one, 9.5, leadW - 8);
    ol.forEach((ln, j) => drawText(x + 4, 368 + j * 12, ln, 9.5, INK));
    drawText(x + 4, 393, lead.source, 8.5, GREY);
    drawTag(x + leadW - 4, 393, lead.tag);
  });

  // ---- 12 small illustrated stories (4 cols x 3 rows)
  const smallW = (CW - 18) / 4;
  const artS = 62;
  SMALLS.forEach((s, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = M + col * (smallW + 6);
    const y = 396 + row * 66;
    s.scene(x, y, artS, artS);
    rect(x, y, artS, artS, hex("#c9bfa4"), 1);
    const tx = x + artS + 6;
    const tw = smallW - artS - 6;
    let hl = wrapText(s.headline, 10, tw, { bold: true, serif: true });
    let ol = wrapText(s.one, 8, tw);
    if (hl.length > 3) hl = hl.slice(0, 3);
    if (hl.length + ol.length > 5) ol = ol.slice(0, 5 - hl.length);
    let cy = y + 11;
    hl.forEach((ln) => {
      drawText(tx, cy, ln, 10, INK, { bold: true, serif: true });
      cy += 11;
    });
    ol.forEach((ln) => {
      drawText(tx, cy, ln, 8, INK);
      cy += 9.5;
    });
    drawText(tx, y + 61, s.source, 7.5, GREY);
    drawTag(x + smallW - 2, y + 61, s.tag);
    if (col < 3) line(x + smallW + 3, y + 2, x + smallW + 3, y + 62, hex("#ddd2b8"));
  });

  // ---- map
  drawMap();

  // ---- briefs 16-36, two columns, hanging indent
  drawText(M, 758, "BRIEFS 16–36", 10, INK, { bold: true });
  line(M, 762, W - M, 762, hex("#c9bfa4"));
  const colW = (CW - 16) / 2;
  const left = BRIEFS.slice(0, 11);
  const right = BRIEFS.slice(11);
  const drawBriefCol = (items: Array<[number, string]>, bx: number): void => {
    let by = 772;
    for (const [n, body] of items) {
      const lines = wrapText(body, 7.5, colW - 18);
      drawText(bx, by, String(n) + ".", 7.5, RED, { bold: true });
      lines.forEach((ln, j) => drawText(bx + 18, by + j * 9.2, ln, 7.5, INK));
      by += lines.length * 9.2;
    }
  };
  drawBriefCol(left, M);
  drawBriefCol(right, M + colW + 16);

  // ---- DATE CHECK box
  rect(M, 918, CW, 58, RED, 2);
  const dcLines = wrapText(DATE_CHECK, 8, CW - 20);
  const dcPrefix = "DATE CHECK — MID-DAY EDITION:";
  dcLines.forEach((ln, j) => {
    const by = 930 + j * 9.5;
    if (j === 0 && ln.startsWith(dcPrefix)) {
      drawText(M + 10, by, dcPrefix, 8, RED, { bold: true });
      drawText(M + 10 + textWidth(dcPrefix, 8, { bold: true }), by, ln.slice(dcPrefix.length), 8, INK);
    } else {
      drawText(M + 10, by, ln, 8, INK);
    }
  });

  // ---- footer
  line(M, 982, W - M, 982, INK);
  const fLines = wrapText(FOOTER, 8, CW);
  fLines.forEach((ln, j) => drawText(M, 992 + j * 10, ln, 8, GREY));
}

// -------------------------------------------------------------------- main
function main(): void {
  render();
  const png = encodePNG();
  const out = process.env.OUTPUT ?? "/output/entry.png";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
}

main();
