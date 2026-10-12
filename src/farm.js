/* The farm view. Depends on src/engine.js (surface, PAL, PALC, T, TILE, mkpal)
 * and src/sprites.js (compileAll) from the shared classic-script scope.
 *
 * SOURCE OF TRUTH -- the one thing to read first.
 * This page renders a model, it does not invent one. It asks a local helm for
 * /api/farm; if nothing answers inside the timeout it loads the committed
 * SYNTHETIC snapshot in data/ and says so, loudly, in the header and the rail.
 * There is no third behaviour: it never fabricates numbers and never draws an
 * empty farm to mean a calm one.
 *
 * MOTION CONTRACT, inherited from the estate it was built for:
 *   - Motion encodes a real event. A steward walks because it has backlog on
 *     disk. Drain every queue and the page is a still image -- which is not a
 *     bug, it is the best news the model can carry.
 *   - A hidden tab draws nothing. visibilitychange cancels the rAF.
 *   - 8fps integer steps. Fractional positions with |0 snapping produce uneven
 *     strides, which is the classic pixel-art tell.
 */
'use strict';

/* ---- objective shirts. Hue carries identity; luminance carries meaning. ----
 * All three slots of every ramp are isoluminant with the authored blue
 * (engine.js worker slots 6-8) to 0.00 in linearized Rec.709: Y = 5.69 /
 * 13.74 / 36.57. Teams are tellable at a glance and the luminance budget the
 * art direction rests on is byte-for-byte unchanged -- so the alert axis keeps
 * the +22 dY it has over every ground surface. */
const SHIRT = {
  ecosystem: ['#32474b', '#3d6f79', '#73acb7'],
  delivery:  ['#24456b', '#2f6aa8', '#58a6ff'],   // the authored ramp, unchanged
  assurance: ['#6402ab', '#9337d5', '#c58bef'],
  comms:     ['#77205a', '#b03788', '#ce90b9'],
};
const PALW = {};
for (const k in SHIRT) {
  const p = PAL.worker.slice();
  p[6] = SHIRT[k][0]; p[7] = SHIRT[k][1]; p[8] = SHIRT[k][2];
  PALW[k] = mkpal(p);
}
const palOf = w => PALW[w.objective] || PALC.worker;

/* ---- the commute state machine ------------------------------------------ */
const HSPD = 2;   // 2px/tick. LEGS[2] spreads ~4px per half-cycle, so 2px at
                  // 8fps is the speed the leg art was drawn for.
const VSPD = 1;   // half speed down the gutter: the walk cycle is pure side
                  // view, so the descent is sold by cadence, not by new art.
const DWELL = 12; // 12 ticks = 1.5s = exactly 4 complete 3-frame swings. A
                  // COUNT, not a timer: four strikes per queue item.
const REST = 6;   // 750ms at the gate. Turning straight round reads as frantic.
const ST = { HOME: 0, OUT: 1, DOWN: 2, IN: 3, WORK: 4, BACK_IN: 5, UP: 6, BACK: 7 };
const WALKING = s => s !== ST.HOME && s !== ST.WORK;

/* Exact arrival by clamping the final step. Integer only -- every step covers
 * the same distance except the clamped last one (1px on an odd span, invisible
 * at 8fps). Returns true on the tick it LANDS, so the next tick starts the
 * next leg and no tick is spent standing still. */
function axis(w, k, to, spd) {
  const d = to - w[k];
  if (d === 0) return true;
  w[k] += (d < 0 ? -1 : 1) * Math.min(spd, Math.abs(d));
  return w[k] === to;
}
// Never flip facing mid-leg, never on a vertical leg: a figure that turns
// while travelling straight down reads as a glitch.
const face = (w, d) => { if (d !== 0) w.dir = d < 0 ? -1 : 1; };

/* ======================================================================== */
function boot(FARM, srcLabel) {
  const synthetic = !!FARM.demo;

  /* ---- layout, pass 1: the whole Y table from the buffer WIDTH alone -----
   * The buffer height must be DERIVED FROM CONTENT. Sizing it from the window
   * caps the canvas at 280px while the layout needs 439, which at 1440x900
   * drew zero of three field rows, all fifteen machine sheds and the freshness
   * line off the bottom. A commute cannot route to a spur that is not on the
   * canvas, so this is a precondition of the motion, not a nicety. */
  const CSSW  = Math.max(880, Math.min(1320, window.innerWidth - 400));
  const SCALE = 3;
  const BUFW  = Math.floor(CSSW / SCALE);

  const BW = 4, BH = 40, FW = 3, FH = 2;
  const bCols = Math.min(5, Math.max(3, Math.floor((BUFW - 16) / (BW * TILE + 6))));
  const bRows = Math.ceil(FARM.buildings.length / bCols);
  const fCols = Math.max(4, Math.floor((BUFW - 16) / (FW * TILE + 4)));
  const fRows = Math.max(1, Math.ceil(FARM.fields.length / fCols));

  const Y = { top: 11, bld: [] };
  let yy = Y.top + 8;
  for (let r = 0; r < bRows; r++) { Y.bld.push(yy); yy += BH + 16; }
  Y.path = yy + 2;
  // 48, not 40: ceil(40/16) = 3, so the bake ALREADY paints three 16px tile
  // rows = 48px into a 40px budget, and the 8px overshoot landed on field-row
  // zero's id labels. Budgeting the 48px the engine actually paints costs
  // nothing and removes a pre-existing 4px overlap.
  Y.pathH = 48;
  Y.lane = [Y.path + 32, Y.path + 39];   // FOOT rows; figures extend 32px UP
  yy = Y.path + Y.pathH + 4;
  Y.fld = [];
  for (let r = 0; r < fRows; r++) { Y.fld.push(yy + 8); yy += FH * TILE + 24; }
  Y.shed = yy + 6;
  Y.need = Y.shed + 24;

  /* ---- layout, pass 2: size the surface to the content ------------------- */
  const S = surface(document.getElementById('host'), CSSW, (Y.need + 4) * SCALE, SCALE);
  const A = compileAll();
  const COLS = Math.floor(S.w / TILE), ROWS = Math.floor(S.h / TILE);
  const bx = i => 8 + (i % bCols) * (BW * TILE + 6);
  const by = i => Y.bld[Math.floor(i / bCols)];
  const fx = i => 8 + (i % fCols) * (FW * TILE + 4);
  const fy = i => Y.fld[Math.floor(i / fCols)];

  /* ---- the walkable graph -----------------------------------------------
   * HOME is the objective's lamp gate, not a department. The model carries no
   * steward->department edge, so naming a building a steward does not provably
   * occupy would be invention. The lamps are already baked and the roster
   * declares the objectives, so home costs zero new pixels. */
  const OBJS = [...new Set(FARM.workers.map(w => w.objective))];
  const NG   = Math.max(2, OBJS.length);
  const gX   = i => 30 + Math.floor(i * (S.w - 60) / (NG - 1)) + 2;
  const FIDX = {}; FARM.fields.forEach((f, i) => FIDX[f.id] = i);
  // clamp: column-0 plots sit at fx=8, so an unclamped gutter of 6 puts the
  // figure 2px and its alert glyph 5px off the left edge. Measured.
  const gutX = i => Math.max(12, fx(i) - 2);
  const ctrX = i => fx(i) + ((FW * TILE) >> 1);
  const hedY = i => fy(i) - 2;                   // headland: feet above the plot
  const LANE = Y.lane;
  const OFFX = Math.min(S.w - 10, gX(NG - 1) + 26);
  const OFFY = LANE[1] + 22;

  /* ---- per-worker init -------------------------------------------------- */
  const atGate = {}, used = {};
  FARM.workers.forEach(w => (atGate[w.objective] = (atGate[w.objective] || 0) + 1));
  FARM.workers.forEach((w, i) => {
    const gi = Math.max(0, OBJS.indexOf(w.objective)), n = atGate[w.objective];
    const slot = (used[w.objective] = (used[w.objective] || 0)); used[w.objective]++;
    // MOBILE is the ground truth, not the derived label: a worker moves
    // because it has backlog. A distress steward with an EMPTY queue has
    // nothing to work, so it is BAKED with a steady alert -- a standing
    // condition does not need to flash, and flashing it would cost 8fps
    // forever for one glyph.
    w.mobile = w.queue > 0;
    w.lane = w.state === 'distress' ? 0 : (i & 1);   // alert glyph in clear air
    w.gx = gX(gi) + slot * 14 - (((n - 1) * 14) >> 1);  // 14px pitch at 16px wide
    w.fy0 = LANE[w.lane];
    w.px = w.gx; w.py = w.fy0; w.dir = 1;
    w.ph = (i * 3) & 3;                  // leg phase: no two neighbours in sync
    w.st = ST.HOME;
    w.rest = 2 + ((i * 7) % 17);         // coprime stagger: no lockstep launch
    w.dwell = 0; w.lap = 0; w.terr = []; w.off = [];
    for (const r of (w.roots || []))
      if (FIDX[r] === undefined) w.off.push(r); else w.terr.push(FIDX[r]);
  });

  function stepWorker(w) {
    if (!w.mobile) return;               // queue 0 is BAKED, never stepped
    switch (w.st) {
      case ST.HOME:
        if (--w.rest > 0) return;
        // one lap per queue item, rotating the territory so the whole of it is
        // visibly visited. No queue-item -> root edge exists in the model, so
        // lap rotation is the honest selector.
        w.fi  = w.terr.length ? w.terr[w.lap % w.terr.length] : -1;
        w.gut = w.fi < 0 ? OFFX : gutX(w.fi);
        w.ctr = w.fi < 0 ? OFFX : ctrX(w.fi);
        w.hed = w.fi < 0 ? OFFY : hedY(w.fi);
        face(w, w.gut - w.px); w.st = ST.OUT; return;
      case ST.OUT:     if (axis(w, 'px', w.gut, HSPD)) w.st = ST.DOWN; return;
      case ST.DOWN:    if (axis(w, 'py', w.hed, VSPD)) { face(w, w.ctr - w.px); w.st = ST.IN; } return;
      case ST.IN:      if (axis(w, 'px', w.ctr, HSPD)) { w.st = ST.WORK; w.dwell = DWELL; } return;
      case ST.WORK:    if (--w.dwell <= 0) { face(w, w.gut - w.px); w.st = ST.BACK_IN; } return;
      case ST.BACK_IN: if (axis(w, 'px', w.gut, HSPD)) w.st = ST.UP; return;
      case ST.UP:      if (axis(w, 'py', w.fy0, VSPD)) { face(w, w.gx - w.px); w.st = ST.BACK; } return;
      case ST.BACK:    if (axis(w, 'px', w.gx, HSPD)) { w.lap++; w.rest = REST; w.st = ST.HOME; } return;
    }
  }

  /* ---- the baked ground layer ------------------------------------------- */
  function lampPool(cx, cy, r) {
    const mid = PAL.ground[12], lit = PAL.ground[13];
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const d2 = x * x + y * y; if (d2 > r * r) continue;
      // Two levels only. A third band needs dither at d>=3, which is
      // 45-degree stripes rather than texture.
      if (d2 <= (r * 0.42) * (r * 0.42)) S.px(cx + x, cy + y, lit);
      else if (((cx + x) + (cy + y)) % 2 === 0) S.px(cx + x, cy + y, mid);
    }
  }
  function hatch(x, y, w, h, step) {      // the one "cannot see this" material
    S.rect(x, y, w, h, '#2a1414');
    for (let i = 0; i < w; i += (step || 3)) S.line(x + i, y, x + i, y + h - 1, '#a32b2b', 2);
  }
  function building(b, x, y) {
    const w = BW * TILE, sick = b.health === 'bad', dead = b.health === 'condemned',
          unobs = b.health === 'unobservable';
    for (let c = 0; c < BW; c++) {        // roof: two authored shingle courses
      S.blit(A.parts.roof, x + c * TILE, y, PALC.build);
      S.blit(A.parts.roof, x + c * TILE, y + 8, PALC.build);
    }
    for (let r = 0; r < 3; r++) for (let c = 0; c < BW; c++)
      S.blit(A.parts.wall, x + c * TILE, y + 16 + r * 8, PALC.build);
    // One window per seat. lit = judged healthy, dim = judged sick, dark =
    // cannot be judged at all. Three states, never two: "unknown" is not a
    // shade of "ok".
    const n = Math.min(b.seats, 5);
    for (let i = 0; i < n; i++) {
      const part = i < b.seats - b.bad - b.unobs ? A.parts.winLit
                 : i < b.seats - b.unobs ? A.parts.winDim : A.parts.winDark;
      S.blit(part, x + 4 + i * 7, y + 20, PALC.build);
    }
    S.blit(A.parts.door, x + (w >> 1) - 3, y + BH - 10, PALC.build);
    // frost is the ONLY use of dither: unobservable is a MATERIAL, never a
    // colour on the green/amber/red axis
    if (unobs) S.frost(x, y, w, BH, PAL.build[11]);
    if (dead)  { S.frost(x, y, w, BH, PAL.build[7]);
                 for (let i = 0; i < w; i += 5) S.line(x + i, y, x + i + 8, y + BH - 1, PAL.build[7], 2); }
    if (sick)  S.frame(x - 1, y - 1, w + 2, BH + 2, '#f85149');
    const c = dead ? '#49525e' : sick ? '#f85149' : '#7d8794';
    S.text(x + ((w - S.tw(b.label)) >> 1), y + BH + 2, b.label, c);
    const sub = sick ? b.bad + '/' + b.seats + ' SICK'
              : unobs ? b.unobs + ' UNJUDGED' : dead ? 'CONDEMNED' : b.seats + ' SEAT';
    S.text(x + ((w - S.tw(sub)) >> 1), y + BH + 9, sub,
      dead ? '#49525e' : sick ? '#f85149' : unobs ? '#7d8794' : '#49525e');
  }
  function field(f, x, y) {
    const tile = !f.surveyed ? null
               : f.neglect >= 3 ? T.over : f.neglect === 2 ? T.weedy : T.soil;
    for (let r = 0; r < FH; r++) for (let c = 0; c < FW; c++) {
      if (tile) S.tilePx(tile, x + c * TILE, y + r * TILE);
      else hatch(x + c * TILE, y + r * TILE, TILE, TILE);  // never a tidy plot
    }
    const w = FW * TILE;
    S.frame(x, y, w, FH * TILE, f.sole ? '#d29922' : '#1b2026');
    if (f.sole) S.blit(A.props.crate, x + w - 7, y + 3, PALC.build);
    S.text(x + 1, y - 8, String(f.id).slice(0, 9), !f.surveyed ? '#f85149' : '#7d8794');
    const soil = f.soil === 'watered' ? 'SAFE' : f.soil === 'dry' ? 'ONE DISK' : 'NO GIT';
    S.text(x + 1, y + FH * TILE + 2, soil,
      f.soil === 'watered' ? '#3fb950' : f.soil === 'dry' ? '#d29922' : '#f85149');
    const NEG = ['TENDED', 'FINE', 'WEEDS', 'OVERGROWN'];
    S.text(x + 1, y + FH * TILE + 9, NEG[f.neglect] + ' ' + Math.round(f.age || 0) + 'D',
      f.neglect >= 3 ? '#d29922' : '#49525e');
  }

  function bakeGround() {
    S.dropGround();
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++)
      S.tile((c + r) % 2 ? T.grassA : T.grassB, c, r);
    for (let c = 0; c <= COLS; c++) for (let r = 0; r < Math.ceil(Y.pathH / TILE); r++)
      S.tilePx(T.path, c * TILE, Y.path + r * TILE);
    // The lamps ARE the home gates, so their count follows the roster rather
    // than a hardcoded 4. On a 4-objective roster gX() reproduces the previous
    // hardcoded x values exactly, so this is a no-op on that shape.
    S.text(8, Y.path - 2, 'HOME GATES - ONE PER OBJECTIVE', '#49525e');
    for (let i = 0; i < NG; i++) {
      const lx = gX(i) - 2;
      lampPool(lx + 2, Y.path + 26, 22);
      S.blit(A.parts.lamp, lx, Y.path - 6, PALC.build);
      const t = String(OBJS[i] || '').toUpperCase().slice(0, 9);
      S.text(gX(i) - (S.tw(t) >> 1), Y.path + 41, t, '#49525e');
    }
    FARM.buildings.forEach((b, i) => building(b, bx(i), by(i)));
    if (!FARM.fields.length) {
      // Zero fields is NOT a calm farm: the registry could not be read. The
      // hatch is deliberately the SAME material as a per-field unsurveyed plot
      // -- "cannot see this field" and "cannot see the map" are one statement
      // at two scales.
      const by0 = Y.fld[0] - 4;
      hatch(8, by0, S.w - 16, 30, 4);
      S.frame(8, by0, S.w - 16, 30, '#f85149');
      S.text((S.w - S.tw('NO MAP - REGISTRY UNREADABLE')) >> 1, by0 + 9, 'NO MAP - REGISTRY UNREADABLE', '#f85149');
      S.text((S.w - S.tw('THIS IS NOT AN EMPTY FARM')) >> 1, by0 + 18, 'THIS IS NOT AN EMPTY FARM', '#e6e9ee');
    } else FARM.fields.forEach((f, i) => field(f, fx(i), fy(i)));
    S.text(8, Y.shed - 9, 'SCHEDULED MACHINES', '#49525e');
    const per = Math.max(8, Math.floor((S.w - 16) / 24));
    FARM.machines.forEach((m, i) => {
      const x = 8 + (i % per) * 24, y = Y.shed + Math.floor(i / per) * 18;
      S.blit(A.props.shed, x, y, PALC.build);
      if (m.state !== 'running') S.frost(x, y, 9, 7, PAL.build[11]);
      const c = m.state === 'running' ? '#3fb950' : m.state === 'faulted' ? '#f85149' : '#49525e';
      S.rect(x + 10, y + 1, 2, 2, c);
      S.text(x, y + 9, String(m.id).slice(0, 4), c);
    });
    const nc = FARM.machines.filter(m => m.state === 'uncontracted').length;
    S.text(8, Y.need, nc + ' OF ' + FARM.machines.length + ' HAVE NO FRESHNESS CONTRACT', '#d29922');

    // territory not in the registry: a steward whose whole territory is absent
    // from the map walks to a hatched VOID, never to a fabricated plot.
    if (FARM.workers.some(w => w.off.length && !w.terr.length)) {
      hatch(OFFX - 12, OFFY + 2, 24, 20);
      S.frame(OFFX - 12, OFFY + 2, 24, 20, '#f85149');
      S.text(OFFX - 12, OFFY - 6, 'OFF REG', '#f85149');
    }
    // THE STILL ONES, BAKED. This is where "healthy is still" stops being an
    // if-statement and becomes the memory layout: a queue-0 steward is painted
    // INTO the ground buffer, so restoreGround() brings it back for free,
    // draw() never touches it, and no later edit can make it animate.
    for (const w of FARM.workers) {
      if (w.mobile) continue;
      S.hline(w.px - 4, w.py + 1, 9, '#0e1014');
      S.hline(w.px - 2, w.py + 2, 5, '#0e1014');
      S.blit(A.frames[0], w.px - 8, w.py - 32, palOf(w), false);
      if (w.state === 'distress') {        // a STANDING condition: steady, not
        S.text(w.px - 11, w.py - 31, '!', '#f85149');     // blinking. Flashing
        S.frame(w.px - 9, w.py - 33, 18, 34, '#f85149');  // would cost 8fps
      }                                                   // forever for a glyph.
      S.text(w.px - 11, w.py + 6, String(w.id).slice(0, 8), '#49525e');
    }
    // header
    S.rect(0, 0, S.w, 9, FARM.weather.verdict === 'OK' ? '#14241a' : '#2a1414');
    S.text(3, 2, 'PIXEL FARM', '#e6e9ee');
    S.text(66, 2, 'WEATHER ' + FARM.weather.verdict,
      FARM.weather.verdict === 'OK' ? '#3fb950' : '#f85149');
    S.text(180, 2, (FARM.weather.breaches || []).length + ' BREACH', '#f85149');
    S.text(248, 2, 'SCAN ' + String(FARM.scanned || '').slice(11, 16), '#49525e');
    // The provenance badge is BAKED, so it cannot be lost to a redraw and
    // cannot be mistaken for a transient toast.
    S.text(S.w - S.tw(synthetic ? 'DEMO DATA' : 'LIVE') - 3, 2,
      synthetic ? 'DEMO DATA' : 'LIVE', synthetic ? '#d29922' : '#3fb950');
    S.captureGround();
  }

  /* ---- per-frame drawing ------------------------------------------------- */
  let tick = 0, last = 0, raf = null;
  function drawWorker(w, blink) {
    const x = w.px - 8, y = w.py - 32, walk = WALKING(w.st);
    // CONTACT SHADOW -- the cheapest cue that a sprite is ON the ground rather
    // than pasted over it. Same ink as the sprite key-line (#0e1014, Y=0.51),
    // so it is the same discipline, not a new colour. Measured dY: 2.42 over
    // path-mid, 1.81 over grass-mid -- inside the structure register (ground
    // ramps span 1.6-2.8) and nowhere near the +22 the alert axis keeps.
    S.hline(w.px - 4, w.py + 1, 9, '#0e1014');
    S.hline(w.px - 2, w.py + 2, 5, '#0e1014');
    // Legs cycle ONLY while translating. A planted figure whose legs cycle is
    // the loudest tell in pixel art, so HOME and WORK both hold frame 0.
    S.blit(walk ? A.frames[(tick + w.ph) & 3] : A.frames[0], x, y, palOf(w), w.dir < 0);

    if (w.st === ST.WORK) {
      // A dead lane is effort with nothing produced, so a steward on a dead
      // lane may not be drawn striking soil: the hoe goes up on tool frame 0
      // and never comes down.
      const refused = w.state === 'distress';
      const ti = refused ? 0 : (tick + w.ph) % 3;
      // y+14, not y+8: puts the strike at the ankles instead of the waist, so
      // the swing visibly reaches the soil it represents.
      S.blit(A.tools[ti], x, y + 14, palOf(w), w.dir < 0);
      if (!refused && ti === 2) {                    // the strike LANDS
        S.px(w.px + w.dir * 3, w.py,     PAL.ground[6]);   // 2px of thrown
        S.px(w.px + w.dir * 5, w.py - 1, PAL.ground[6]);   // soil, 1 tick in 3
      }
    }
    // QUEUE DEPTH as discrete pips, never a shrinking number: the queue on
    // disk has NOT drained, so nothing here may claim it has. The COUNT is
    // constant and only the LIT pip advances, one per completed lap.
    const n = Math.min(w.queue, 6), act = w.lap % Math.max(1, w.queue);
    for (let i = 0; i < n; i++)
      S.rect(x + 2 + i * 3, y - 3, 2, 2, (i === act && act < n) ? '#e6e9ee' : '#49525e');
    if (w.queue > 6) S.text(x + 20, y - 4, '+' + (w.queue - 6), '#49525e');

    if (w.state === 'distress' && blink) {
      S.text(w.px - 11, y + 1, '!', '#f85149');   // LEFT of the head, not above:
      S.frame(x - 1, y - 1, 18, 34, '#f85149');   // above collides with the
    }                                             // building sub-label row.
    S.text(w.px - 11, w.py + 6, String(w.id).slice(0, 8),
      w.state === 'distress' ? '#f85149' : '#3fb950');
  }

  function draw(now) {
    const blink = ((now / 380) | 0) % 2 === 0;
    S.restoreGround();
    // Painter's order by LIVE foot row: lower on screen = nearer = drawn later
    // = occludes. A static lane sort cannot work once workers move vertically,
    // because a worker at a far plot would draw over one on the near path.
    [...FARM.workers].filter(w => w.mobile)
      .sort((a, b) => a.py - b.py || a.px - b.px)
      .forEach(w => drawWorker(w, blink));
    S.present();
  }

  /* ---- the scheduler ---------------------------------------------------- */
  // The predicate is DERIVED FROM DATA, never from a wish for motion. If every
  // queue drained, anyMobile() goes false, rAF is never scheduled, and the
  // farm is a still image. Motion is EARNED by backlog.
  const anyMobile = () => FARM.workers.some(w => w.queue > 0);
  function frame(now) {
    if (document.hidden) { raf = null; return; }   // hidden tab draws nothing
    if (now - last > 125) {                        // 8fps: the 16-bit cadence
      last = now; tick++;
      for (const w of FARM.workers) stepWorker(w);
      draw(now);
    }
    raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
    else if (!raf && anyMobile()) { last = 0; raf = requestAnimationFrame(frame); }
  });

  bakeGround();
  draw(0);
  if (anyMobile()) raf = requestAnimationFrame(frame);

  /* ---- the rail: DOM owns language, canvas owns space and motion ---------
   * The 4x6 bitmap font is uppercase-only, so prose drawn into the canvas
   * could not be read, selected, searched with cmd-F or reached by a screen
   * reader. Every word and number therefore lives in the DOM. */
  const g = FARM.gold || {};
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const W = (h, b) => `<div class="w"><h4>${h}</h4>${b}</div>`;
  const row = (k, v, cls) => `<div class="r"><span>${k}</span><b class="${cls || ''}">${esc(v)}</b></div>`;
  const fieldsN = FARM.fields.length;
  document.getElementById('rail').innerHTML =
    (synthetic
      ? W('Demo data', `<p class="note">These numbers are <b>synthetic</b>, generated by
          <code>tools/make-demo.js</code> to exercise every visual state. No real
          repository, department, backlog or spend figure appears anywhere in this
          repository. Pointed at a local helm on <code>/api/farm</code>, the same
          page renders live state and this panel is replaced by a LIVE badge.</p>`)
      : W('Live data', `<p class="note">Served from <code>/api/farm</code> at
          ${esc(String(FARM.scanned || '').slice(0, 16).replace('T', ' '))}.</p>`))
  + W('Weather &mdash; charter scope',
      row('verdict', FARM.weather.verdict, FARM.weather.verdict === 'OK' ? 'ok' : 'bad')
    + row('mission floor', (FARM.weather.mission * 100).toFixed(0) + '% / 50%', FARM.weather.mission < .5 ? 'bad' : 'ok')
    + row('meta ceiling', (FARM.weather.meta * 100).toFixed(0) + '% / 25%', FARM.weather.meta > .25 ? 'bad' : 'ok')
    + `<ul>${(FARM.weather.breaches || []).map(b => `<li class="bad">${esc(b)}</li>`).join('')}</ul>`)
  + W('Soil &mdash; ' + fieldsN + ' fields',
      row('safe (git + remote)', FARM.fields.filter(f => f.soil === 'watered').length, 'ok')
    + row('one disk only', (FARM.dry || []).length, 'warn')
    + row('no version control', (FARM.fallow || []).length, 'bad')
    + row('never surveyed', (FARM.unsurveyed || []).length, 'bad')
    + ((FARM.dry || []).length ? `<ul><li class="warn">one disk: ${esc((FARM.dry || []).join(', '))}</li>` : '<ul>')
    + ((FARM.fallow || []).length ? `<li class="bad">no git: ${esc((FARM.fallow || []).join(', '))}</li></ul>` : '</ul>'))
  + W('Workers &mdash; ' + FARM.workers.length + ' stewards',
      FARM.workers.map(w => `<div class="r"><span>${esc(String(w.id).toLowerCase())} `
    + `<span class="dm">T${esc(w.tier)} ${esc(w.objective)}</span></span>`
    + `<b class="${w.state === 'distress' ? 'bad' : w.state === 'working' ? 'ok' : 'dm'}">`
    + `${esc(w.state)}${w.queue ? ' &middot; ' + w.queue + 'q' : ''}</b></div>`).join('')
    + `<p class="note">A steward walks only while it has backlog. Drain every
       queue and this page stops scheduling frames entirely.</p>`)
  + W('Cannot be judged',
      row('seats with no tolerance', (FARM.unjudgeableSeats || []).length, 'dm')
    + `<ul>${(FARM.unjudgeableSeats || []).map(s => `<li class="dm">${esc(s.seat)} `
    + `<span class="warn">${esc(s.age)}d</span> (${esc(s.cadence)})</li>`).join('')}</ul>`
    + `<p class="note">A cadence of <code>on-demand</code> or <code>monitor</code>
       yields no tolerance, so nothing can ever call these seats unhealthy. They
       render frosted &mdash; never green. "Unknown" is not a shade of "ok".</p>`)
  + W('Gold &mdash; weekly API spend, counts down only',
      row('$' + (g.cap - g.week).toFixed(2) + ' left of $' + g.cap, (g.pct || 0) + '%', g.over ? 'bad' : 'ok')
    + `<div class="bar"><i style="width:${Math.min(100, g.pct || 0)}%;background:${g.over ? '#f85149' : '#3fb950'}"></i></div>`)
  + W('Legend',
     `<div class="key">
        <span><i class="sw" style="background:#2e241b"></i>tilled</span>
        <span><i class="sw" style="background:#28301d"></i>weeds</span>
        <span><i class="sw" style="background:#1f2417"></i>overgrown</span>
        <span><i class="sw" style="background:#a32b2b"></i>never surveyed</span>
        <span><i class="sw" style="background:#d29922"></i>lamp / sole copy</span>
        <span><i class="sw" style="background:#6b7684"></i>frost = unjudgeable</span>
      </div>
      <p class="note">Shirt hue is the steward's objective; all four ramps are
      isoluminant, so team identity never spends the alert channel.</p>`);
}

/* ======================================================================== */
/* THE LOADER. Live helm first, committed synthetic snapshot second, an
 * explicit failure third. Never an empty farm, never invented numbers.      */
const SRC = {
  live: '/api/farm',
  demo: './data/farm-demo.json',
  nomap: './data/farm-demo-nomap.json',
};
// 700ms: a local helm answers in single-digit ms, so this is ~100x headroom
// and still imperceptible before the snapshot lands. On GitHub Pages
// /api/farm is a 404, which resolves immediately -- the timeout is a guard
// against a hung socket, not the expected path.
const LIVE_MS = 700, FILE_MS = 8000;

function valid(m) {
  return m && typeof m === 'object'
    && Array.isArray(m.fields) && Array.isArray(m.buildings)
    && Array.isArray(m.workers) && Array.isArray(m.machines)
    && m.weather && typeof m.weather.verdict === 'string';
}
async function get(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;                 // a 404 falls through, it never throws
    const j = await res.json();
    return valid(j) ? j : null;               // a valid-looking 200 that is not a
  } catch (e) { return null; }                // farm model is also a miss
  finally { clearTimeout(timer); }
}
function fail(html) {
  document.getElementById('rail').innerHTML =
    `<div class="w"><h4 class="bad">No model</h4><p class="note">${html}</p></div>`;
}
(async () => {
  const q = new URLSearchParams(location.search);
  const want = q.get('demo');                 // ?demo=1 forces the snapshot,
                                              // ?demo=nomap loads the alarm fixture
  if (location.protocol === 'file:') {
    // fetch() of a relative path is blocked on file://, so say so instead of
    // rendering a blank canvas and letting someone think the page is broken.
    return fail(`Opened over <code>file://</code>, where <code>fetch()</code> cannot
      read a relative path. Serve the directory instead:
      <br><code>python3 -m http.server 8080</code> then open
      <code>http://localhost:8080/</code>.`);
  }
  let model = null, label = '';
  if (!want) { model = await get(SRC.live, LIVE_MS); if (model) label = 'LIVE'; }
  if (!model) {
    model = await get(want === 'nomap' ? SRC.nomap : SRC.demo, FILE_MS);
    if (model) label = 'DEMO';
  }
  if (!model) return fail(`Neither <code>/api/farm</code> nor the committed snapshot
    in <code>data/</code> returned a valid model. Nothing is drawn on purpose: an
    empty farm would read as a calm one.`);
  boot(model, label);
})();
