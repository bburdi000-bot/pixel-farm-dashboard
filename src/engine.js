/* engine2 — a 16-bit TILE engine, built to the measured art direction.
 *
 * Five changes from office-pixel.js, each for a stated reason:
 *
 *  1. COMPILED PALETTE BLIT. office-pixel.js's px() calls parse(c) once PER
 *     PIXEL, keyed by a hex STRING. Sprites compile once to a Uint8Array of
 *     palette indices and blit resolves colour through a Uint8Array table.
 *     Slot 0 is reserved transparent -- a hard stencil, never a blend, which
 *     is the same discipline as dither-not-alpha.
 *  2. AUTHORED TILE INTERIORS. A field of flat rects reads as a diagram no
 *     matter the palette. Stardew reads as Stardew because every 16px tile has
 *     authored interior pixels -- blades, furrows, mortar -- at tight local
 *     contrast. That is what the ground layer below is.
 *  3. CACHED GROUND. The floor is static between polls, so it is rendered once
 *     into a held buffer and each frame starts with data.set(ground).
 *  4. DITHER ONLY AT d=2. ((x+i)+(y+j))%d is a true checkerboard at d=2; at
 *     d>=3 it is continuous 45-degree stripes, i.e. blueprint hatch. Dither is
 *     therefore reserved for ONE job: the frosted "unobservable" material.
 *  5. PRE-PACKED FONT. The original comment claims the font is packed once;
 *     it actually re-splits a string per character per call. Packed here.
 *
 * Palette discipline, measured in linearized Rec.709 and the reason the ground
 * is dark rather than Stardew-daylight: office-pixel.js allocates LOW internal
 * contrast to structure (flr span 3.62, wal 3.49) and HIGH to meaning (grn
 * 33.41, amb 32.74, blu 33.74). Every ground ramp below spans 1.6-2.8, so the
 * green/amber/red axis keeps 23+ dY of headroom on every surface. A warm
 * daylight grass measures dY +7.8 for #f85149 -- the faulted alert goes
 * isoluminant and sinks into the field.
 */
const TILE = 16;

/* ---------------------------------------------------------------- palettes */
// Slot 0 is ALWAYS transparent. Index with hex chars 1-9,a-f in authored rows.
const PAL = {
  ground: [null,
    '#16231a','#1d2e21','#263a2a',   // 1-3 grass      dark/mid/light
    '#241c15','#2e241b','#3a2d22',   // 4-6 soil       dark/mid/light
    '#23252a','#2d3036','#393d44',   // 7-9 path       dark/mid/light
    '#1f2417','#333d25',             // a-b weed       dark/light
    '#4d3c17','#64501f',             // c-d lamp pool  mid/light
  ],
  build: [null,
    '#2a1f16','#36281c','#443325',   // 1-3 wall  dark/mid/light
    '#241a1c','#2e2124','#3b2b2e',   // 4-6 roof  dark/mid/light
    '#0e1014',                        // 7   outline / shadow
    '#d29922','#9a6c15',              // 8-9 lamp-lit window, dim window
    '#1b1e22',                        // a   dark window (sick seat)
    '#6b7684',                        // b   frost (unobservable)
  ],
  worker: [null,
    '#0e1014',                        // 1 outline (key-line: reads on any ground)
    '#3b2412','#55361b',              // 2-3 hair dark/light
    '#b8824f','#d9a066',              // 4-5 skin shadow/lit
    '#24456b','#2f6aa8','#58a6ff',    // 6-8 shirt dark/mid/lit
    '#1b2430','#2b3a4a',              // 9-a trousers dark/lit
    '#6b4a28','#9c6a40',              // b-c tool handle/head
  ],
};

function mkpal(hexes) {
  const p = new Uint8Array(hexes.length * 3);
  for (let i = 1; i < hexes.length; i++) {
    const h = hexes[i]; if (!h) continue;
    const n = parseInt(h.slice(1), 16);
    p[i*3] = (n >> 16) & 255; p[i*3+1] = (n >> 8) & 255; p[i*3+2] = n & 255;
  }
  return p;
}
const PALC = { ground: mkpal(PAL.ground), build: mkpal(PAL.build), worker: mkpal(PAL.worker) };

/* Compile authored rows to palette indices once. '.' and ' ' are transparent. */
function compile(rows) {
  const h = rows.length, w = rows[0].length, idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error('ragged sprite row ' + y);
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      idx[y*w + x] = (c === '.' || c === ' ') ? 0 : parseInt(c, 16);
    }
  }
  return { w, h, idx };
}

/* ------------------------------------------------------------ ground tiles */
/* Authored interiors. Grass is a base tone with 2px blades and the odd dark
 * speck -- NOT per-pixel noise, which reads as dither. Two variants so a field
 * does not visibly repeat. Soil is 4px-period furrows: light crest, mid body,
 * dark trough, which is what makes tilled earth read as tilled. */
const T = {
  grassA: compile([
    '2223222222222222',
    '2233322222232222',
    '2223222222232222',
    '2222222222231222',
    '2122222322221222',
    '2122223332222222',
    '2222221322222232',
    '2222221222222232',
    '2222122232222222',
    '2322122232222222',
    '2322222222122222',
    '2322222222122221',
    '2222232222222221',
    '2222333222222322',
    '2222232223222322',
    '2222222223222222',
  ]),
  grassB: compile([
    '2222222223222222',
    '2222212233322222',
    '2232212222222222',
    '2232222122222322',
    '2232222122222322',
    '2222222222222323',
    '2222222222222223',
    '2212223222222222',
    '2212233322222212',
    '2222223222232212',
    '2222222222333222',
    '2322222222232222',
    '2322222232221222',
    '2222222232221222',
    '2222322232122222',
    '2222322222122222',
  ]),
  // tilled: four furrows, crest/body/trough, with one broken pixel per band so
  // it is not mechanically regular
  soil: compile([
    '6666666566666666','5555555555555555','4444444444444444','5555555555555555',
    '6666666666665666','5555555555555555','4444444444444444','5555555555555555',
    '6665666666666666','5555555555555555','4444444444444444','5555555555555555',
    '6666666666666566','5555555555555555','4444444444444444','5555555555555555',
  ]),
  // weeds taking the bed: furrows still visible, weed sprouts breaking through
  weedy: compile([
    '666a666566666666','55a5555555b55555','4444444444444444','5555555b55555555',
    'a666666666665666','5555b55555555555','44444444444a4444','5555555555555555',
    '666566666b666666','55555555555555a5','4444444444444444','555b555555555555',
    '6666666a66666566','5555555555555555','44444444444444a4','55555b5555555555',
  ]),
  // overgrown: weeds have it, soil only glimpsed
  over: compile([
    'abaaaaabaaaaabaa',
    'bbbababbbaaabbba',
    'ababbbabaabaabaa',
    'aaaabaaa5bbbaaaa',
    'aaaabaaa5abaaaab',
    'aabaaaaaaabaaabb',
    'abbbaabaaaaabaab',
    'aabaabbbababbbaa',
    'aa5aaababbbabaaa',
    'ba5aaaaaabaaaaaa',
    'bbabaaaaabaaaaba',
    'babbbaabaaababbb',
    'aaabaabbbabbbaba',
    'aaabababaaaba5aa',
    'aaaabbbaaaaba5aa',
    'aaaaab5aaaaaaaaa',
  ]),
  // cobble: irregular stones, dark mortar
  path: compile([
    '7888887788888887','8999988899999888','8998888899988887','7788889988888877',
    '8888899988899988','8999988888899988','8998888899988887','7778899988888877',
    '8889998888888998','8999888889998998','8888888899988887','7788999988888877',
    '8899988888889988','8998888899999888','8888888899988887','7788889988888877',
  ]),
};

/* ---------------------------------------------------------------- surface */
function surface(host, cssW, cssH, scale) {
  const w = Math.floor(cssW / scale), h = Math.floor(cssH / scale);
  const buf = document.createElement('canvas');
  buf.width = w; buf.height = h;
  const b = buf.getContext('2d'); b.imageSmoothingEnabled = false;
  const out = document.createElement('canvas');
  out.width = w * scale; out.height = h * scale;
  out.style.width = (w * scale) + 'px'; out.style.height = (h * scale) + 'px';
  out.style.imageRendering = 'pixelated';
  const o = out.getContext('2d'); o.imageSmoothingEnabled = false;
  if (host) host.appendChild(out);

  const img = b.createImageData(w, h);
  const data = img.data;
  let ground = null;                       // cached static floor

  const hex = {};
  const rgb = c => hex[c] || (hex[c] = (n => [(n>>16)&255,(n>>8)&255,n&255])(parseInt(c.slice(1),16)));

  const S = {
    w, h, scale, data,

    px(x, y, c) { x|=0; y|=0; if (x<0||y<0||x>=w||y>=h) return;
      const p = rgb(c), i = (y*w+x)*4;
      data[i]=p[0]; data[i+1]=p[1]; data[i+2]=p[2]; data[i+3]=255; },
    hline(x, y, l, c) { for (let i=0;i<l;i++) S.px(x+i,y,c); },
    rect(x, y, rw, rh, c) { for (let j=0;j<rh;j++) S.hline(x,y+j,rw,c); },
    frame(x, y, rw, rh, c) { S.hline(x,y,rw,c); S.hline(x,y+rh-1,rw,c);
      for (let j=0;j<rh;j++){ S.px(x,y+j,c); S.px(x+rw-1,y+j,c);} },
    clear(c) { for (let y=0;y<h;y++) S.hline(0,y,w,c); },
    line(x0,y0,x1,y1,c,step){ x0|=0;y0|=0;x1|=0;y1|=0;
      const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
      let err=dx+dy,n=0;
      for(;;){ if(!step||n%step===0)S.px(x0,y0,c); n++;
        if(x0===x1&&y0===y1)break; const e2=2*err;
        if(e2>=dy){err+=dy;x0+=sx;} if(e2<=dx){err+=dx;y0+=sy;} } },

    /* Dither at d=2 ONLY. Higher densities are diagonal stripes, not texture,
     * so the signature deliberately refuses them. Reserved for frost. */
    frost(x, y, rw, rh, c) {
      for (let j=0;j<rh;j++) for (let i=0;i<rw;i++)
        if (((x+i)+(y+j)) % 2 === 0) S.px(x+i,y+j,c);
    },

    /* Compiled blit. Clipping hoisted out of the inner loop; flip is w-1-i on
     * the READ index, so one right-facing sheet serves left for free. */
    blit(s, dx, dy, pal, flip) {
      const P = pal || PALC.worker;
      const y0 = Math.max(0, -dy), y1 = Math.min(s.h, h - dy);
      const x0 = Math.max(0, -dx), x1 = Math.min(s.w, w - dx);
      for (let y = y0; y < y1; y++) {
        const row = y * s.w, drow = (dy + y) * w;
        for (let x = x0; x < x1; x++) {
          const k = s.idx[row + (flip ? s.w - 1 - x : x)];
          if (k === 0) continue;
          const d = (drow + dx + x) * 4, p = k * 3;
          data[d] = P[p]; data[d+1] = P[p+1]; data[d+2] = P[p+2]; data[d+3] = 255;
        }
      }
    },
    tile(t, cx, cy) { S.blit(t, cx * TILE, cy * TILE, PALC.ground, false); },
    tilePx(t, x, y) { S.blit(t, x, y, PALC.ground, false); },

    /* Ground cache: render the floor once, then every frame starts with a
     * single typed-array copy instead of a clear + full tilemap pass. */
    captureGround() { ground = new Uint8ClampedArray(data); },
    restoreGround() { if (ground) data.set(ground); else S.clear('#0e1014'); },
    hasGround: () => !!ground,
    dropGround() { ground = null; },

    text(x, y, s, c) {
      let cx = x;
      for (const ch of String(s).toUpperCase()) {
        const g = FONT[ch];
        if (g === undefined) { cx += 5; continue; }
        for (let r = 0; r < 6; r++) { const bits = g[r];
          for (let i = 0; i < 4; i++) if (bits & (8 >> i)) S.px(cx+i, y+r, c); }
        cx += 5;
      }
      return cx - x;
    },
    tw: s => String(s).length * 5,
    present() { b.putImageData(img,0,0); o.clearRect(0,0,out.width,out.height);
      o.drawImage(buf,0,0,w,h,0,0,out.width,out.height); },
    canvas: out,
  };
  return S;
}

/* Font, PACKED ONCE to 6 nibbles per glyph -- the thing office-pixel.js's
 * comment claims and its code does not do (it re-splits a string per char). */
const FONT = (() => {
  const SRC = {
    A:'0110 1001 1001 1111 1001 1001', B:'1110 1001 1110 1001 1001 1110',
    C:'0111 1000 1000 1000 1000 0111', D:'1110 1001 1001 1001 1001 1110',
    E:'1111 1000 1110 1000 1000 1111', F:'1111 1000 1110 1000 1000 1000',
    G:'0111 1000 1011 1001 1001 0111', H:'1001 1001 1111 1001 1001 1001',
    I:'1110 0100 0100 0100 0100 1110', J:'0011 0001 0001 0001 1001 0110',
    K:'1001 1010 1100 1100 1010 1001', L:'1000 1000 1000 1000 1000 1111',
    M:'1001 1111 1111 1001 1001 1001', N:'1001 1101 1111 1011 1001 1001',
    O:'0110 1001 1001 1001 1001 0110', P:'1110 1001 1110 1000 1000 1000',
    Q:'0110 1001 1001 1011 1010 0101', R:'1110 1001 1110 1100 1010 1001',
    S:'0111 1000 0110 0001 0001 1110', T:'1111 0110 0110 0110 0110 0110',
    U:'1001 1001 1001 1001 1001 0110', V:'1001 1001 1001 1001 0110 0110',
    W:'1001 1001 1001 1111 1111 1001', X:'1001 1001 0110 0110 1001 1001',
    Y:'1001 1001 0110 0110 0110 0110', Z:'1111 0001 0010 0100 1000 1111',
    0:'0110 1001 1011 1101 1001 0110', 1:'0010 0110 0010 0010 0010 0111',
    2:'0110 1001 0001 0010 0100 1111', 3:'1110 0001 0110 0001 0001 1110',
    4:'0010 0110 1010 1111 0010 0010', 5:'1111 1000 1110 0001 0001 1110',
    6:'0110 1000 1110 1001 1001 0110', 7:'1111 0001 0010 0010 0100 0100',
    8:'0110 1001 0110 1001 1001 0110', 9:'0110 1001 1001 0111 0001 0110',
    ' ':'0000 0000 0000 0000 0000 0000', '.':'0000 0000 0000 0000 0000 0100',
    ':':'0000 0100 0000 0000 0100 0000', '-':'0000 0000 0000 1111 0000 0000',
    '/':'0001 0001 0010 0100 1000 1000', '!':'0100 0100 0100 0100 0000 0100',
    '+':'0000 0100 1110 0100 0000 0000', '%':'1001 0001 0010 0100 1000 1001',
    '(':'0010 0100 0100 0100 0100 0010', ')':'0100 0010 0010 0010 0010 0100',
    '>':'1000 0100 0010 0010 0100 1000', '=':'0000 0000 1111 0000 1111 0000',
    '#':'1010 1111 1010 1111 1010 0000', '?':'0110 1001 0010 0100 0000 0100',
  };
  const out = {};
  for (const k in SRC) out[k] = SRC[k].split(' ').map(r => parseInt(r, 2));
  return out;
})();

/* Dual-mode tail: in a browser `module` is undefined and this is a no-op. In
 * Node it lets tools/artcheck.js measure the SAME authored rows the browser
 * renders, instead of a copy in a JSON file that can silently drift. */
if (typeof module !== 'undefined' && module.exports)
  module.exports = { TILE, PAL, PALC, T, mkpal, compile, FONT, surface };
