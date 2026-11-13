// Renders the Windows installer images (NSIS header/sidebar, WiX banner/dialog) from SVG with
// headless Edge and writes them as 24-bit BMP files into src-tauri/installer/.
//
//   node scripts/installer-images.mjs
//
// No dependencies: Edge takes the screenshots, and the PNG → BMP conversion is done here.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'src-tauri', 'installer');

const EDGE = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p));
if (!EDGE) throw new Error('Microsoft Edge not found (set EDGE_PATH)');

const ACCENT_TOP = '#3d7ff2';
const ACCENT_BOTTOM = '#2a60c8';
/** The toolbar mark on a 24-unit grid. */
const mark = (color) => `
  <rect x="2" y="3" width="9" height="7" rx="1.5" fill="${color}" />
  <rect x="13" y="14" width="9" height="7" rx="1.5" fill="${color}" />
  <path d="M11 6.5h3.5v11H13" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" />`;

/** An accent panel with the mark, the name and a tagline (installer welcome pages). */
const panel = (w, h) => `
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${ACCENT_TOP}" /><stop offset="1" stop-color="${ACCENT_BOTTOM}" /></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#bg)" />
  <g transform="translate(${w / 2 - 36} 70) scale(3)">${mark('#ffffff')}</g>
  <text x="${w / 2}" y="178" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="24" font-weight="600" fill="#ffffff">xdiagram</text>
  <text x="${w / 2}" y="202" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#dbe7ff">Database diagrams</text>`;

const IMAGES = [
  {
    // NSIS: top-right of every page's header, on white.
    file: 'nsis-header.bmp', w: 150, h: 57,
    svg: `<rect width="150" height="57" fill="#ffffff" />
      <g transform="translate(14 13.5) scale(1.25)">${mark(ACCENT_BOTTOM)}</g>
      <text x="50" y="36" font-family="Segoe UI, sans-serif" font-size="17" font-weight="600" fill="#1f2937">xdiagram</text>`,
  },
  // NSIS: left side of the welcome and finish pages.
  { file: 'nsis-sidebar.bmp', w: 164, h: 314, svg: panel(164, 314) },
  {
    // WiX: banner across the top of the inner dialogs; WiX draws the title text on its left.
    file: 'wix-banner.bmp', w: 493, h: 58,
    svg: `<rect width="493" height="58" fill="#ffffff" />
      <g transform="translate(441 14) scale(1.25)">${mark(ACCENT_BOTTOM)}</g>`,
  },
  {
    // WiX: welcome / finish dialog background; the text sits on the white right part.
    file: 'wix-dialog.bmp', w: 493, h: 312,
    svg: `<rect width="493" height="312" fill="#ffffff" /><svg width="164" height="312">${panel(164, 312)}</svg>`,
  },
];

const tmp = mkdtempSync(path.join(tmpdir(), 'xdiagram-installer-'));
mkdirSync(outDir, { recursive: true });
try {
  for (const img of IMAGES) {
    const html = path.join(tmp, `${img.file}.html`);
    const png = path.join(tmp, `${img.file}.png`);
    writeFileSync(html, `<!doctype html><html><body style="margin:0;overflow:hidden">
      <svg xmlns="http://www.w3.org/2000/svg" width="${img.w}" height="${img.h}" style="display:block">${img.svg}</svg></body></html>`);
    execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${img.w},${img.h}`, `--screenshot=${png}`, `file:///${html.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore' });
    const { width, height, rgb } = decodePng(readFileSync(png));
    if (width !== img.w || height !== img.h) throw new Error(`${img.file}: got ${width}x${height}, expected ${img.w}x${img.h}`);
    writeFileSync(path.join(outDir, img.file), encodeBmp(width, height, rgb));
    console.log(`wrote src-tauri/installer/${img.file} (${width}x${height})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced (what Chromium screenshots are). */
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) px.copy(rgb, i * 3, i * bpp, i * bpp + 3);
  return { width, height, rgb };
}

/** 24-bit uncompressed BMP (BITMAPINFOHEADER, bottom-up rows padded to 4 bytes). */
function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const out = Buffer.alloc(size);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      out[dst + x * 3] = rgb[s + 2];
      out[dst + x * 3 + 1] = rgb[s + 1];
      out[dst + x * 3 + 2] = rgb[s];
    }
  }
  return out;
}
