#!/usr/bin/env node
/* Objective scorer for the authored pixel art. It reads src/engine.js and
 * src/sprites.js DIRECTLY -- the compiled tiles are decompiled back to rows --
 * so it measures the exact bytes the browser blits. There is no JSON copy of
 * the art to drift out of sync.
 *
 * Thresholds, all computed from the engine's own palette rather than chosen:
 *   detail     >= 12%  share of pixels differing from the tile's modal value.
 *                      A flat tile reads as a diagram at ANY palette.
 *   clustering >= 50%  share of detail pixels with a 4-neighbour of equal value.
 *                      Isolated pixels read as noise -- dither by accident.
 *   span       <= 8    linearized Rec.709 luminance span of the colours used.
 *                      Ground stays in the structure register so the
 *                      green/amber/red alert axis keeps its own channel.
 *   maxY       < 20    no ground pixel may sit in the alert register.
 * Only 16x16 ground tiles are scored strictly; sprites and parts are measured
 * and reported, because a 4x6 window frame cannot meet a texture threshold.
 */
'use strict';
const E = require('../src/engine.js');
const S = require('../src/sprites.js');

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const Y = h => { const n = parseInt(h.slice(1), 16);
  return 100 * (0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)); };

/* compiled sprite -> authored rows. Measures post-compile() reality. */
const decompile = s => Array.from({ length: s.h }, (_, y) =>
  Array.from({ length: s.w }, (_, x) => { const k = s.idx[y * s.w + x];
    return k === 0 ? '.' : k.toString(16); }).join(''));

function score(name, rows, palName) {
  const pal = E.PAL[palName], problems = [];
  const w = rows[0].length, h = rows.length;
  rows.forEach((r, i) => { if (r.length !== w) problems.push(`row ${i} is ${r.length}, expected ${w}`); });
  const counts = {}, used = new Set();
  for (const r of rows) for (const ch of r) {
    if (ch === '.' || ch === ' ') { counts['.'] = (counts['.'] || 0) + 1; continue; }
    const k = parseInt(ch, 16);
    if (!(k > 0 && k < pal.length && pal[k])) { problems.push(`char '${ch}' not in ${palName} palette`); continue; }
    counts[ch] = (counts[ch] || 0) + 1; used.add(ch);
  }
  const n = w * h;
  const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const modeCh = mode ? mode[0] : null;
  const detail = mode ? 100 * (n - mode[1]) / n : 0;
  let det = 0, nb = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ch = rows[y][x]; if (ch === ' ') ch = '.';
    if (ch === modeCh) continue;
    det++;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      let o = rows[ny][nx]; if (o === ' ') o = '.';
      if (o === ch) { nb++; break; }
    }
  }
  const clus = det ? 100 * nb / det : 100;
  const ys = [...used].map(ch => Y(pal[parseInt(ch, 16)]));
  return { name, w, h, detail, clus,
    span: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    maxY: ys.length ? Math.max(...ys) : 0, colours: used.size, problems };
}

function verdict(s, strict) {
  const f = [];
  if (s.problems.length) f.push('INVALID');
  if (strict) {
    if (s.detail < 12) f.push('FLAT');
    if (s.clus < 50)   f.push('NOISY');
    if (s.span > 8)    f.push('SPAN');
    if (s.maxY >= 20)  f.push('ALERT-REGISTER');
  }
  return f.length ? f.join('+') : 'pass';
}

/* ---- the set: every authored block in the project ----------------------- */
const items = [];
for (const k in E.T) items.push([k, decompile(E.T[k]), 'ground', true]);  // strict
items.push(['torso', S.TORSO, 'worker', false]);
S.LEGS.forEach((r, i)  => items.push([`legs[${i}]`,  r, 'worker', false]));
S.TOOLS.forEach((r, i) => items.push([`tools[${i}]`, r, 'worker', false]));
for (const k in S.PARTS) items.push([`parts.${k}`, S.PARTS[k], 'build', false]);
for (const k in S.PROPS) items.push([`props.${k}`, S.PROPS[k], 'build', false]);
// the 32-row composite the renderer actually blits
S.LEGS.forEach((l, i) => items.push([`figure[${i}]`, S.TORSO.concat(l), 'worker', false]));

let bad = 0;
console.log('name                size    detail  clus   span   maxY  cols  verdict');
console.log('-'.repeat(72));
for (const [name, rows, pal, strict] of items) {
  const s = score(name, rows, pal), v = verdict(s, strict);
  if (v !== 'pass') bad++;
  console.log(`${name.padEnd(19)} ${(s.w + 'x' + s.h).padEnd(7)} ${s.detail.toFixed(1).padStart(6)}% ${s.clus.toFixed(0).padStart(4)}% `
    + `${s.span.toFixed(2).padStart(6)} ${s.maxY.toFixed(1).padStart(6)} ${String(s.colours).padStart(5)}  ${strict ? v : v + ' (not scored)'}`);
  s.problems.slice(0, 3).forEach(p => console.log('      ! ' + p));
}

/* ---- the contrast invariant the whole art direction rests on ------------- */
console.log('-'.repeat(72));
const ALERT = '#f85149';
const surfaces = { 'grass mid': E.PAL.ground[2], 'soil mid': E.PAL.ground[5],
                   'path mid': E.PAL.ground[8], 'weed light': E.PAL.ground[11] };
let minDY = Infinity;
for (const k in surfaces) {
  const d = Y(ALERT) - Y(surfaces[k]);
  minDY = Math.min(minDY, d);
  console.log(`alert dY over ${k.padEnd(11)} +${d.toFixed(2)}`);
}
if (minDY < 15) { console.log(`\nALERT HEADROOM LOST: min dY ${minDY.toFixed(2)} < 15`); bad++; }
else console.log(`\nalert headroom: min dY +${minDY.toFixed(2)} over every ground surface (floor 15)`);
console.log(bad === 0 ? 'ART SET PASSES' : `${bad} ITEM(S) FAILED`);
process.exit(bad ? 1 : 0);
