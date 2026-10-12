#!/usr/bin/env node
/* pixedit — the round trip between authored row strings and PNGs.
 *
 * WHY THIS EXISTS. Row strings in source are the right COMMITTED form: they
 * diff, they review, they need no binary in a repo whose server reads every
 * file with readFileSync(fp,'utf8'). But typing them by hand is the actual
 * bottleneck on art quality, and no amount of discipline fixes a tool problem.
 *
 * So: export every authored tile and prop to PNG, edit them in Aseprite /
 * Libresprite / Pixelorama / anything, import them back to strings. The strings
 * stay the source of truth; the PNGs are scratch and are gitignored.
 *
 * THE IMPORT IS STRICT, and that is the point. Every pixel must be an EXACT
 * palette colour. An editor that antialiases an edge, picks an off-ramp colour,
 * or saves at the wrong bit depth gets REFUSED with the offending pixel
 * coordinates — because a near-miss colour is how a palette quietly grows into
 * the hex-per-element mush the whole art system exists to prevent.
 *
 * PNG is written and read with nothing but node's zlib. No npm, consistent with
 * the rest of the repo.
 *
 *   node tools/pixedit.js export [dir]     # default .pixedit/
 *   node tools/pixedit.js import [dir]     # prints row strings, verifies palette
 *   node tools/pixedit.js import [dir] --write   # rewrites src/ in place
 *   node tools/pixedit.js palette [dir]    # a reference swatch strip per palette
 *   node tools/pixedit.js verify           # assert the round trip is lossless (CI)
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');

/* ----------------------------------------------------------------- PNG I/O */
const CRCT = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
const crc32 = b => { let c = ~0; for (const x of b) c = CRCT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit, RGBA
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                    // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, bd = 0, ct = 0, inter = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4);
                           bd = data[8]; ct = data[9]; inter = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error(`bit depth ${bd}; save as 8 bits per channel`);
  if (inter) throw new Error('interlaced PNG; save without Adam7 interlacing');
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!bpp) throw new Error(`colour type ${ct} unsupported; export as RGB or RGBA, not indexed`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                           v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      line[i] = v;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ct === 6) { out[o] = line[x*4]; out[o+1] = line[x*4+1]; out[o+2] = line[x*4+2]; out[o+3] = line[x*4+3]; }
      else if (ct === 2) { out[o] = line[x*3]; out[o+1] = line[x*3+1]; out[o+2] = line[x*3+2]; out[o+3] = 255; }
      else if (ct === 0) { out[o] = out[o+1] = out[o+2] = line[x]; out[o+3] = 255; }
      else { out[o] = out[o+1] = out[o+2] = line[x*2]; out[o+3] = line[x*2+1]; }
    }
  }
  return { w, h, rgba: out };
}

/* ------------------------------------------------------- the authored art */
/* Loaded from the MODULES, not parsed from text -- the same way artcheck.js
 * does it, so a new prop appears in both tools automatically and the two can
 * never disagree about what the art is.
 *
 * PROP_PAL below is the one duplicated fact. tools/artcheck.js:100 is its
 * authority: props are authored in the GROUND palette (they index the two
 * shadow slots e and f), and `shed` alone is build. Guessing "everything in
 * sprites.js is build" silently mis-exported 12 of 49 items. */
const E = require('../src/engine.js');
const S = require('../src/sprites.js');
const PROP_PAL = { shed: 'build' };

const rgb = hex => { const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const palettes = () => E.PAL;

/* compiled sprite -> authored rows (tiles are stored compiled) */
const decompile = s => Array.from({ length: s.h }, (_, y) =>
  Array.from({ length: s.w }, (_, x) => { const k = s.idx[y * s.w + x];
    return k === 0 ? '.' : k.toString(16); }).join(''));

/* `patch` says how --write finds this block again in source. null = no
 * in-place rewrite available; the rows are printed for manual paste. */
function blocks() {
  const out = [];
  for (const k in E.T)
    out.push({ key: k, rows: decompile(E.T[k]), pal: 'ground',
               file: 'src/engine.js', patch: k });
  out.push({ key: 'torso', rows: S.TORSO, pal: 'worker',
             file: 'src/sprites.js', patch: 'TORSO' });
  S.LEGS.forEach((r, i)  => out.push({ key: `legs-${i}`,  rows: r, pal: 'worker',
                                       file: 'src/sprites.js', patch: null }));
  S.TOOLS.forEach((r, i) => out.push({ key: `tools-${i}`, rows: r, pal: 'worker',
                                       file: 'src/sprites.js', patch: null }));
  for (const k in S.PARTS)
    out.push({ key: `parts.${k}`, rows: S.PARTS[k], pal: 'build',
               file: 'src/sprites.js', patch: k });
  for (const k in S.PROPS)
    out.push({ key: `props.${k}`, rows: S.PROPS[k], pal: PROP_PAL[k] || 'ground',
               file: 'src/sprites.js', patch: k });
  return out;
}

/* ------------------------------------------------------------------ export */
function doExport(dir) {
  const PAL = palettes(), bs = blocks();
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const b of bs) {
    const pal = PAL[b.pal];
    if (!pal) { console.log(`  skip ${b.key}: no palette '${b.pal}'`); continue; }
    const w = b.rows[0].length, h = b.rows.length;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ch = b.rows[y][x], o = (y * w + x) * 4;
      if (ch === '.' || ch === ' ') { rgba[o+3] = 0; continue; }
      const hex = pal[parseInt(ch, 16)];
      if (!hex) { rgba[o+3] = 0; continue; }
      const [r, g, bl] = rgb(hex);
      rgba[o] = r; rgba[o+1] = g; rgba[o+2] = bl; rgba[o+3] = 255;
    }
    fs.writeFileSync(path.join(dir, `${b.pal}__${b.key}.png`), encodePNG(w, h, rgba));
    n++;
  }
  console.log(`exported ${n} item(s) to ${dir}/`);
  console.log(`  filename is  <palette>__<name>.png  -- do not rename it, the import reads it`);
  console.log(`  edit at 1:1, 8-bit RGBA, no interlacing, palette colours ONLY`);
  console.log(`  then: node tools/pixedit.js import ${dir}`);
}

/* ------------------------------------------------------------------ import */
function doImport(dir, write) {
  const PAL = palettes();
  const lut = {};
  for (const k in PAL) { lut[k] = new Map();
    PAL[k].forEach((hex, i) => { if (hex) lut[k].set(rgb(hex).join(','), i.toString(16)); }); }

  // '_'-prefixed files are reference material the export writes for the editor
  // (palette strips); they are not art and must not be parsed as art.
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png') && f.includes('__') && !f.startsWith('_'));
  if (!files.length) { console.log('no <palette>__<name>.png files in ' + dir); process.exit(1); }

  const got = [], problems = [];
  for (const f of files.sort()) {
    const [palName, rest] = f.replace(/\.png$/, '').split('__');
    const name = rest;
    if (!lut[palName]) { problems.push(`${f}: unknown palette '${palName}'`); continue; }
    let img;
    try { img = decodePNG(fs.readFileSync(path.join(dir, f))); }
    catch (e) { problems.push(`${f}: ${e.message}`); continue; }
    const rows = [];
    let bad = 0;
    for (let y = 0; y < img.h; y++) {
      let row = '';
      for (let x = 0; x < img.w; x++) {
        const o = (y * img.w + x) * 4;
        if (img.rgba[o+3] < 128) { row += '.'; continue; }
        const key = [img.rgba[o], img.rgba[o+1], img.rgba[o+2]].join(',');
        const slot = lut[palName].get(key);
        if (slot === undefined) {
          if (bad < 4) problems.push(
            `${f}: pixel (${x},${y}) is rgb(${key}) which is NOT in the ${palName} palette`);
          bad++; row += '?';
        } else row += slot;
      }
      rows.push(row);
    }
    if (bad > 4) problems.push(`${f}: ...and ${bad - 4} more off-palette pixel(s)`);
    if (!bad) got.push({ name, palName, rows, w: img.w, h: img.h });
  }

  if (problems.length) {
    console.log('REFUSED — the palette contract is not optional:\n');
    problems.slice(0, 24).forEach(p => console.log('  ' + p));
    if (problems.length > 24) console.log(`  ...${problems.length - 24} more`);
    console.log('\nFix the colours in your editor and re-import. Nothing was written.');
    process.exit(1);
  }

  console.log(`${got.length} item(s) imported clean:\n`);
  for (const g of got) console.log(`  ${g.palName}__${g.name}  ${g.w}x${g.h}`);

  if (!write) {
    console.log('\n--- row strings (pass --write to patch src/ in place) ---');
    for (const g of got) {
      console.log(`\n  ${g.name}: compile([`);
      g.rows.forEach(r => console.log(`    '${r}',`));
      console.log('  ]),');
    }
    return;
  }

  // In-place patch, keyed on the block's own source identifier.
  const meta = {}; blocks().forEach(b => { meta[b.key] = b; });
  let patched = 0; const manual = [];
  for (const file of SRC) {
    let s = fs.readFileSync(file, 'utf8'), changed = false;
    for (const g of got) {
      const b = meta[g.name];
      if (!b || b.file !== file) continue;
      if (!b.patch) { if (!manual.includes(g.name)) manual.push(g.name); continue; }
      const re = new RegExp(
        `((?:const\\s+)?\\b${b.patch}\\b\\s*(?::|=)\\s*(?:compile|c)?\\s*\\(?\\s*\\[)([\\s\\S]*?)(\\])`);
      const m = s.match(re);
      if (!m) { if (!manual.includes(g.name)) manual.push(g.name); continue; }
      const body = '\n' + g.rows.map(r => `    '${r}',`).join('\n') + '\n  ';
      s = s.slice(0, m.index) + m[1] + body + m[3] + s.slice(m.index + m[0].length);
      changed = true; patched++;
    }
    if (changed) { fs.writeFileSync(file, s); console.log(`\npatched ${file}`); }
  }
  console.log(`${patched} block(s) rewritten.`);
  if (manual.length) {
    console.log(`\n${manual.length} block(s) live inside an array and are NOT auto-patched`);
    console.log(`(${manual.join(', ')}) -- paste these by hand:`);
    for (const n of manual) {
      const g = got.find(x => x.name === n);
      console.log(`\n  // ${n}`);
      console.log('  [' + g.rows.map(r => `'${r}'`).join(',') + '],');
    }
  }
  console.log(`\nNow run: node tools/artcheck.js`);
}

/* ----------------------------------------------------------------- palette */
function doPalette(dir) {
  const PAL = palettes();
  fs.mkdirSync(dir, { recursive: true });
  for (const k in PAL) {
    const hexes = PAL[k].slice(1), SW = 8;
    const w = hexes.length * SW, h = SW;
    const rgba = Buffer.alloc(w * h * 4);
    hexes.forEach((hex, i) => { const [r, g, b] = rgb(hex);
      for (let y = 0; y < h; y++) for (let x = 0; x < SW; x++) {
        const o = (y * w + i * SW + x) * 4;
        rgba[o] = r; rgba[o+1] = g; rgba[o+2] = b; rgba[o+3] = 255; } });
    fs.writeFileSync(path.join(dir, `_palette__${k}.png`), encodePNG(w, h, rgba));
    console.log(`  _palette__${k}.png  ${hexes.length} slot(s)`);
  }
  console.log('Load these as your editor palette so you cannot pick an off-ramp colour.');
}

/* ------------------------------------------------------------------ verify */
/* Round-trips every block through a real PNG encode+decode in memory and
 * asserts the rows come back byte-identical. This is the gate that keeps the
 * tool honest: the moment encode, decode, a palette or a prop's palette
 * assignment drifts, art silently changes shape on its way through an editor. */
function doVerify() {
  const PAL = palettes(), bs = blocks();
  const lut = {};
  for (const k in PAL) { lut[k] = new Map();
    PAL[k].forEach((hex, i) => { if (hex) lut[k].set(rgb(hex).join(','), i.toString(16)); }); }
  let ok = 0; const bad = [];
  for (const b of bs) {
    const pal = PAL[b.pal];
    const w = b.rows[0].length, h = b.rows.length;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ch = b.rows[y][x], o = (y * w + x) * 4;
      if (ch === '.' || ch === ' ') { rgba[o+3] = 0; continue; }
      const hex = pal[parseInt(ch, 16)];
      if (!hex) { bad.push(`${b.key}: char '${ch}' absent from ${b.pal}`); continue; }
      const [r, g, bl] = rgb(hex);
      rgba[o] = r; rgba[o+1] = g; rgba[o+2] = bl; rgba[o+3] = 255;
    }
    let img;
    try { img = decodePNG(encodePNG(w, h, rgba)); }
    catch (e) { bad.push(`${b.key}: ${e.message}`); continue; }
    const back = [];
    for (let y = 0; y < img.h; y++) { let row = '';
      for (let x = 0; x < img.w; x++) { const o = (y * img.w + x) * 4;
        if (img.rgba[o+3] < 128) { row += '.'; continue; }
        const slot = lut[b.pal].get([img.rgba[o], img.rgba[o+1], img.rgba[o+2]].join(','));
        row += slot === undefined ? '?' : slot; }
      back.push(row); }
    const want = b.rows.map(r => r.replace(/ /g, '.'));
    if (JSON.stringify(back) === JSON.stringify(want)) ok++;
    else bad.push(`${b.key}: rows changed through the PNG round trip`);
  }
  console.log(`round trip: ${ok}/${bs.length} byte-identical`);
  if (bad.length) { bad.slice(0, 10).forEach(b => console.log('  FAIL ' + b));
    console.log('PIXEDIT ROUND TRIP BROKEN'); process.exit(1); }
  console.log('PIXEDIT ROUND TRIP LOSSLESS');
}

const [cmd, dirArg] = process.argv.slice(2);
const dir = dirArg && !dirArg.startsWith('--') ? dirArg : '.pixedit';
const write = process.argv.includes('--write');
if (cmd === 'export') doExport(dir);
else if (cmd === 'import') doImport(dir, write);
else if (cmd === 'palette') doPalette(dir);
else if (cmd === 'verify') doVerify();
else { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n')
  .filter(l => l.startsWith(' *') || l.startsWith('/*')).map(l => l.replace(/^\/?\*ic?\s?/, '').replace(/^ \* ?/, '')).join('\n')); process.exit(1); }
