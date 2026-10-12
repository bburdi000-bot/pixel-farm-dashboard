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
 * Measured in linearized Rec.709: the four ramps are isoluminant with each
 * other to within 0.101 / 0.241 / 0.002 at slots 6 / 7 / 8, landing at
 * Y = 5.7 / 10.5 / 13.7. The shipped lit slot was 36.57 -- BRIGHTER than
 * #f85149 (26.32), so the identity channel was outshouting the alert channel
 * on every figure. Re-levelling costs nothing, because hue was always the
 * channel carrying identity and luminance was only ever along for the ride.
 * All four hues are cool, deliberately clear of the red/amber/green anchors,
 * so a shirt can never be read as ok / warn / bad. */
const RAMPS = [
  ['#28494f', '#36616a', '#3d6f79'],   // teal
  ['#1f466e', '#295e94', '#2f6aa8'],   // blue (the authored ramp, re-levelled)
  ['#61248c', '#8231bc', '#9337d5'],   // violet
  ['#742459', '#9b3178', '#b03788'],   // magenta
];
const PALW = {};

/* ---- the commute state machine ------------------------------------------ */
const HSPD = 2;   // 2px/tick. LEGS[2] spreads ~4px per half-cycle, so 2px at
                  // 8fps is the speed the leg art was drawn for.
const VSPD = 1;   // half speed down the gutter: the cycle is a 3/4 side view,
                  // so the descent is sold by cadence, not by new art. With
                  // the gait now keyed to DISTANCE this also halves the leg
                  // rate automatically, which is the whole skating fix.
const DWELL = 12; // 12 ticks = 1.5s = exactly 4 complete 3-frame swings. A
                  // COUNT, not a timer: four strikes per queue item.
const REST = 6;   // 750ms at the gate. Turning straight round reads as frantic.
const ST = { HOME: 0, OUT: 1, DOWN: 2, IN: 3, WORK: 4, BACK_IN: 5, UP: 6, BACK: 7 };

/* Exact arrival by clamping the final step, and the step is RECORDED so the
 * gait can key off real distance instead of off the clock. Integer only: every
 * step covers the same distance except the clamped last one (1px on an odd
 * span, invisible at 8fps), so `=== to` is a valid test with no epsilon and no
 * overshoot. Returns true on the tick it LANDS, so no tick is spent at a
 * corner. w.dx is the ONLY thing the leg frame may consult, and it is set here
 * and nowhere else -- which is what makes the no-treadmill invariant
 * structural rather than inferred from three separate conditions. */
function move(w, k, to, spd) {
  const d = to - w[k];
  if (d === 0) { w.dx = 0; return true; }
  const s = (d < 0 ? -1 : 1) * Math.min(spd, Math.abs(d));
  w[k] += s; w.dx = s; w.travel += Math.abs(s);
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
  // Ramps are assigned by POSITION in the live roster. The shipped SHIRT table
  // was keyed by objective NAME with the DEMO fixture's names, so palOf() fell
  // through to the default blue for 7 of 10 workers on the live model and only
  // the ecosystem stewards got a hue. A silent fallback is what hid it.
  OBJS.forEach((o, i) => { const p = PAL.worker.slice(), r = RAMPS[i % RAMPS.length];
    p[6] = r[0]; p[7] = r[1]; p[8] = r[2]; PALW[o] = mkpal(p); });
  const palOf = w => PALW[w.objective] || PALC.worker;
  // A FRESHNESS CONTRACT ON THE ROSTER ITSELF. Motion is a readout of backlog,
  // so the readout has to be in date; queueAgeDays is the mtime of the steward
  // roster, emitted by the derive layer. Absent => the gate is inert, not wrong.
  const qAge = FARM.queueAgeDays;
  const rosterFresh = qAge == null || qAge <= 7;
  const SURV = {}; FARM.fields.forEach((fd, i) => { SURV[i] = fd.surveyed !== false; });
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
    w.mobile = w.queue > 0 && rosterFresh;
    w.frozen = w.queue > 0 && !rosterFresh;
    w.lane = w.state === 'distress' ? 0 : (i & 1);   // alert glyph in clear air
    w.gx = gX(gi) + slot * 14 - (((n - 1) * 14) >> 1);  // 14px pitch at 16px wide
    w.fy0 = LANE[w.lane];
    w.px = w.gx; w.py = w.fy0; w.dir = 1;
    w.ph = (i * 3) & 3;                  // leg phase: no two neighbours in sync
    w.st = ST.HOME;
    w.rest = 2 + ((i * 7) % 17);         // coprime stagger: no lockstep launch
    w.dwell = 0; w.lap = 0; w.terr = []; w.off = [];
    w.travel = (i * 3) & 7; w.dx = 0; w.onVoid = false;
    for (const r of (w.roots || []))
      if (FIDX[r] === undefined) w.off.push(r); else w.terr.push(FIDX[r]);
  });

  function stepWorker(w) {
    w.dx = 0;                            // reset every tick; see move()
    if (!w.mobile) return;               // queue 0 or a stale roster is BAKED
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
        // THE GROUND decides whether work may be shown, not the charter lane.
        w.onVoid = w.fi < 0 || !SURV[w.fi];
        face(w, w.gut - w.px); w.st = ST.OUT; return;
      case ST.OUT:     if (move(w, 'px', w.gut, HSPD)) w.st = ST.DOWN; return;
      case ST.DOWN:    if (move(w, 'py', w.hed, VSPD)) { face(w, w.ctr - w.px); w.st = ST.IN; } return;
      case ST.IN:      if (move(w, 'px', w.ctr, HSPD)) { w.st = ST.WORK; w.dwell = DWELL; } return;
      case ST.WORK:    if (--w.dwell <= 0) { face(w, w.gut - w.px); w.st = ST.BACK_IN; } return;
      case ST.BACK_IN: if (move(w, 'px', w.gut, HSPD)) w.st = ST.UP; return;
      case ST.UP:      if (move(w, 'py', w.fy0, VSPD)) { face(w, w.gx - w.px); w.st = ST.BACK; } return;
      case ST.BACK:    if (move(w, 'px', w.gx, HSPD)) { w.lap++; w.rest = REST; w.st = ST.HOME; } return;
    }
  }

  /* ---- the ground tilemap -----------------------------------------------
   * MurmurHash3 finalizer on a 2-D mix. The table has 16 entries so the
   * reduction is a MASK, not a modulo, and there is no modulo bias at all.
   * MEASURED, and it contradicts what was proposed: a WOVEN table is not
   * better here. Sorted measures H 15.36-16.94% / V 15.70-18.01% adjacency
   * against a true chance of 17.97% -- at or BELOW chance -- while every woven
   * table I tried came out above it (best 18.23-18.72%). With a proper
   * avalanche and a power-of-2 mask the hash needs no help; weaving only pays
   * when the table's own period interacts with a modulo.
   * The shipped code was (c+r)%2 over two variants: a 45-degree plaid with
   * period (2,0) and exactly 1 distinct tile per parity -- the same geometry
   * engine.js forbids for dither, arriving through the tilemap instead. */
  function ghash(c, r) {
    let h = ((c * 73856093) ^ (r * 19349663)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, 3266489917) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  const GV = [T.grass1, T.grass2, T.grass3, T.grass4, T.grassTuft, T.grassStone];
  // frequencies are auditable by reading the table: 4 quiet at 18.75%,
  // tuft 18.75%, stone 6.25%. Measured longest same-variant run: 4 tiles.
  const GTAB = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5];

  /* ---- the baked ground layer ------------------------------------------- */
  const JIT = [0, 1, 0, 2, 1, 0, 1, 2, 0, 1];
  function lampPool(cx, cy, r) {
    const mid = PAL.ground[12], lit = PAL.ground[13];
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      // ELLIPTICAL: light falling on a flat plane seen at this angle is an
      // ellipse; a circle reads as a decal. And the outer band is now a SOLID
      // two-level falloff with a per-column jitter instead of a d=2
      // checkerboard -- engine.js declares dither "reserved for ONE job: the
      // frosted unobservable material", so a dithered light pool had two
      // meanings riding one material. The checkerboard now belongs to frost
      // alone, which is what the engine's own comment already promises.
      const d2 = x * x + y * y * 2.4; if (d2 > r * r) continue;
      if (d2 <= (r * 0.42) * (r * 0.42)) { S.px(cx + x, cy + y, lit); continue; }
      const rr = r - JIT[(cx + x + 64) % 10];
      if (d2 <= rr * rr) S.px(cx + x, cy + y, mid);
    }
  }
  /* The one "cannot see this" material. The shipped version was S.rect in
   * '#2a1414' plus S.line at step 3 stippled at step 2 -- two colours in
   * NEITHER palette, and a texture made of LINES. It is now the real ground
   * tile (voidTile: broken earth, detail 24.6% / clustering 94%) with the
   * sanctioned d=2 frost in the alert red over it, so the terrain stays
   * terrain and the alert keeps carrying the meaning. */
  function hatch(x, y, w, h) {
    for (let j = 0; j < h; j += TILE) for (let i = 0; i < w; i += TILE)
      S.tilePx(T.voidTile, x + i, y + j);
    S.frost(x, y, w, h, '#a32b2b');
  }
  function building(b, x, y) {
    const w = BW * TILE, sick = b.health === 'bad', dead = b.health === 'condemned',
          unobs = b.health === 'unobservable';
    // CONTACT SHADOW first, so the structure sits on top of it. Nothing in the
    // shipped scene cast one: a 64x40 building floated on grass.
    S.blit(A.props.shadCapL, x - 3, y + BH - 2, PALC.ground);
    for (let i = 0; i < (w >> 3); i++)
      S.blit(A.props.shadMid, x + 2 + i * 8, y + BH - 2, PALC.ground);
    S.blit(A.props.shadCapL, x + w - 2, y + BH - 2, PALC.ground, true);
    // roofC, not roof: PARTS.roof has col0 === col15 on ALL EIGHT rows because
    // its stagger has period 3 and 16 % 3 === 1, so every one of the 40 tile
    // joins puts two like pixels together and the stagger breaks. roofC has
    // period 4; its run lengths measure a constant 2 in-tile AND across a join.
    for (let c = 0; c < BW; c++) {
      S.blit(A.parts.roofC, x + c * TILE, y, PALC.build);
      S.blit(A.parts.roofC, x + c * TILE, y + 8, PALC.build);
    }
    // wallClap, not wall: PARTS.wall has SIX of eight rows full-width
    // single-value, so three stacked courses draw a hard full-width horizontal
    // band every 4px across 24px of wall -- a venetian blind. wallClap has none.
    for (let r = 0; r < 3; r++) for (let c = 0; c < BW; c++)
      S.blit(A.parts.wallClap, x + c * TILE, y + 16 + r * 8, PALC.build);
    // One window per seat. lit = judged healthy, dim = judged sick, dark =
    // cannot be judged at all. Three states, never two: "unknown" is not a
    // shade of "ok".
    const n = Math.min(b.seats, 5);
    for (let i = 0; i < n; i++) {
      const part = i < b.seats - b.bad - b.unobs ? A.parts.winLit
                 : i < b.seats - b.unobs ? A.parts.winDim : A.parts.winDark;
      // CENTRED as a group. The shipped stride was hardcoded from x+4, so a
      // 1-seat building put its single window 25px left of a centred door and
      // left 55px of blank siding -- and three of the ten departments are
      // 1-seat. Integer shift, so nothing snaps.
      S.blit(part, x + ((w - (n * 7 - 2)) >> 1) + i * 7, y + 20, PALC.build);
    }
    S.blit(A.parts.door, x + (w >> 1) - 3, y + BH - 10, PALC.build);
    // frost is the ONLY use of dither: unobservable is a MATERIAL, never a
    // colour on the green/amber/red axis
    if (unobs) S.frost(x, y, w, BH, PAL.build[11]);
    // The diagonal S.line hatch is GONE: dx=8 over dy=39 is a ~78 degree
    // stipple, which is exactly the d>=3 continuous-stripe artefact engine.js
    // forbids in the same file that drew it. S.frost IS the sanctioned d=2.
    if (dead)  { S.frost(x, y, w, BH, PAL.build[7]);
                 S.blit(A.props.stump, x + w - 9, y + BH + 1, PALC.ground); }
    // The red 1px frame is GONE: drawn 1px OUTSIDE its own bounds it overwrote
    // the grass and read as a selection box above the world, and because it was
    // baked it could never blink. The label and the N/M SICK sub-label below
    // already carry the alert in #f85149, so the channel is not lost.
    if (sick)  S.blit(A.props.rockSmall, x - 2, y + BH + 1, PALC.ground);
    // '#7d8794' measures Y=23.83 -- inside the Y>=20 alert register, for a
    // neutral label. '#49525e' (8.26) is the dim value the sub-label already
    // uses, and unobs keeps the frost-adjacent grey so the two stay distinct.
    const c = dead ? '#49525e' : sick ? '#f85149' : unobs ? '#7d8794' : '#49525e';
    S.text(x + ((w - S.tw(b.label)) >> 1), y + BH + 2, b.label, c);
    const sub = sick ? b.bad + '/' + b.seats + ' SICK'
              : unobs ? b.unobs + ' UNJUDGED' : dead ? 'CONDEMNED' : b.seats + ' SEAT';
    S.text(x + ((w - S.tw(sub)) >> 1), y + BH + 9, sub,
      dead ? '#49525e' : sick ? '#f85149' : unobs ? '#7d8794' : '#49525e');
  }
  function field(f, x, y, idx) {
    // PER-CELL selection. The shipped loop blitted ONE tile for all six cells,
    // so every plot was a hard-edged rectangle butted against grass with no
    // transition at all -- the single loudest amateur tell in the image.
    // At FW=3/FH=2 every cell IS an edge or a corner, so the plot renders
    // entirely as NW/N/NE over SW/S/SE and no interior tile is ever drawn.
    const interior = f.neglect >= 3 ? T.over : f.neglect === 2 ? T.weedy : T.soil;
    const NV = ghash(idx, 0) & 1;                 // plot tops differ plot to plot
    for (let r = 0; r < FH; r++) for (let c = 0; c < FW; c++) {
      const px = x + c * TILE, py = y + r * TILE;
      if (!f.surveyed) { S.tilePx(T.voidTile, px, py); continue; }
      const n = r === 0, s = r === FH - 1, wst = c === 0, e = c === FW - 1;
      let t = interior;
      if (n && wst) t = T.soilNW; else if (n && e) t = T.soilNE;
      else if (s && wst) t = T.soilSW; else if (s && e) t = T.soilSE;
      else if (n) t = NV ? T.soilN2 : T.soilN;
      else if (s) t = NV ? T.soilS2 : T.soilS;
      else if (wst) t = T.soilW; else if (e) t = T.soilE;
      S.tilePx(t, px, py);
    }
    const w = FW * TILE;
    // The 1px '#1b2026' rectangle is GONE. It was in no palette, it was a
    // diagram stroke drawn around world geometry, and the transition tiles ARE
    // the boundary now -- a stroke on top of them cancels the whole point.
    // A fence is an object in the world and carries the same containment.
    for (let c = 0; c < FW; c++) {
      S.blit(A.props.fenceRail, x + c * TILE, y - 5, PALC.ground);
      S.blit(A.props.fenceRail, x + c * TILE, y + FH * TILE + 1, PALC.ground);
    }
    S.blit(A.props.fencePost, x - 1, y - 6, PALC.ground);
    S.blit(A.props.fencePost, x + w - 2, y - 6, PALC.ground);
    // sole_copy_risk keeps its meaning but becomes an OBJECT, not a highlight
    // on a box: crateBig is 12x11 against the shipped crate's 4x4 (a 2x2
    // interior = 12 screen px with a 6px hole), for the ONE field in the
    // estate where loss is irreversible.
    if (f.sole) S.blit(A.props.crateBig, x + w - 15, y + FH * TILE - 13, PALC.ground);
    S.text(x + 1, y - 12, String(f.id).slice(0, 9), !f.surveyed ? '#f85149' : '#7d8794');
    const soil = f.soil === 'watered' ? 'SAFE' : f.soil === 'dry' ? 'ONE DISK' : 'NO GIT';
    S.text(x + 1, y + FH * TILE + 6, soil,
      f.soil === 'watered' ? '#3fb950' : f.soil === 'dry' ? '#d29922' : '#f85149');
    const NEG = ['TENDED', 'FINE', 'WEEDS', 'OVERGROWN'];
    S.text(x + 1, y + FH * TILE + 13, NEG[f.neglect] + ' ' + Math.round(f.age || 0) + 'D',
      f.neglect >= 3 ? '#d29922' : '#49525e');
  }

  function bakeGround() {
    S.dropGround();
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++)
      S.tile(GV[GTAB[ghash(c, r) & 15]], c, r);
    // 3 edge variants x 3 interiors, all placed by the same hash. The band went
    // from 1 distinct 16px column slice of 28 (and a 16px period) to 18 of 28
    // with no period inside 224px.
    const PN = [T.pathN, T.pathN2, T.pathN3], PM = [T.path, T.pathB, T.pathC],
          PS = [T.pathS, T.pathS2, T.pathS3];
    for (let c = 0; c <= COLS; c++) {
      S.tilePx(PN[ghash(c, 101) % 3], c * TILE, Y.path);
      S.tilePx(PM[ghash(c, 102) % 3], c * TILE, Y.path + TILE);
      S.tilePx(PS[ghash(c, 103) % 3], c * TILE, Y.path + 2 * TILE);
    }
    // The lamps ARE the home gates, so their count follows the roster rather
    // than a hardcoded 4. On a 4-objective roster gX() reproduces the previous
    // hardcoded x values exactly, so this is a no-op on that shape.
    S.text(8, Y.path - 2, 'HOME GATES - ONE PER OBJECTIVE', '#49525e');
    for (let i = 0; i < NG; i++) {
      const lx = gX(i) - 2;
      lampPool(lx + 2, Y.path + 26, 22);
      // PARTS.lamp is a ONE-pixel post: a 3px scratch at SCALE=3 with no
      // key-line and no ground contact. Two blits at ONE origin, because the
      // amber must stay in PAL.build and the shadow must stay in PAL.ground --
      // lanternPost rows 0-5 are transparent precisely so the head lands here.
      S.blit(A.props.lanternPost, lx - 1, Y.path - 14, PALC.ground);
      S.blit(A.parts.lanternHead, lx - 1, Y.path - 14, PALC.build);
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
    } else FARM.fields.forEach((f, i) => field(f, fx(i), fy(i), i));
    S.text(8, Y.shed - 9, 'SCHEDULED MACHINES', '#49525e');
    const per = Math.max(8, Math.floor((S.w - 16) / 24));
    FARM.machines.forEach((m, i) => {
      const x = 8 + (i % per) * 24, y = Y.shed + Math.floor(i / per) * 18;
      S.blit(A.props.shadShed, x - 1, y + 5, PALC.ground);
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
      // A STALE ROSTER IS FROSTED, NOT WALKING. frost is already the material
      // for "cannot be judged"; a steward whose backlog list is past its
      // freshness contract is exactly that, and the alternative is nine
      // figures walking forever at a fixed speed off a hand-edited file.
      if (w.frozen) S.frost(w.px - 8, w.py - 32, 16, 32, PAL.build[11]);
      // The per-worker id label is GONE. It was drawn at w.py+6, which
      // overprinted the BAKED gate label at Y.path+41 by 3px on lane 0 and 2px
      // on lane 1 -- at the same x, because a resting worker sits at its own
      // gate for REST ticks every lap -- and spilled 3px past the cobble onto
      // grass. The rail prints every id permanently, which is the page's own
      // stated contract.
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
    const x = w.px - 8, y = w.py - 32;
    // CONTACT SHADOW. Same ink as the sprite key-line (#0e1014, Y=0.51), so it
    // is the same discipline rather than a new colour; it is also now PAL.ground
    // slot e, so the prop shadows and the figure shadow are one value.
    S.hline(w.px - 4, w.py + 1, 9, PAL.ground[14]);
    S.hline(w.px - 2, w.py + 2, 5, PAL.ground[14]);
    // THE GAIT IS A FUNCTION OF DISTANCE, NOT OF TIME. 2px per leg frame is the
    // authored stride. The shipped code indexed A.frames by `tick`, which ran
    // the legs at 1 frame/tick while the body translated 2px/tick horizontally
    // but only 1px/tick vertically -- so 40.9% of all walking (measured over
    // 4800 ticks) ran the cycle at 2x the stride, i.e. skating, and 389 ticks
    // advanced a leg frame with ZERO translation. dx === 0 forces the contact
    // pose, so a leg frame now cannot advance unless the figure moved.
    S.blit(w.dx ? A.frames[(w.travel >> 1) & 3] : A.frames[0], x, y, palOf(w), w.dir < 0);

    if (w.st === ST.WORK) {
      // TWO FACTS, TWO CHANNELS. A dead lane is a property of the STEWARD, so
      // it keeps the blinking '!' and gains frost. Whether work can be SHOWN is
      // a property of the GROUND: INDEX and SECURITY till claude_cfg and
      // ARCHIVE tills the unsurveyed archive field -- surveyed:false, drawn by voidTile
      // as ground nobody has walked -- and LIFE routes to the OFF REG void,
      // whose entire meaning is "we do not know where this work happens". The
      // shipped code keyed the refusal to the charter lane alone, so it refused
      // the healthiest ground on the farm and struck the deadest.
      const refused = w.state === 'distress' || w.onVoid;
      const ti = refused ? 0 : (tick + w.ph) % 3;
      S.blit(A.tools[ti], x, y + 14, palOf(w), w.dir < 0);
      if (!refused && ti === 2) {                    // the strike LANDS
        S.px(w.px + w.dir * 3, w.py,     PAL.ground[6]);
        S.px(w.px + w.dir * 5, w.py - 1, PAL.ground[6]);
      }
    }
    // QUEUE DEPTH, unary and static. The shipped version advanced a LIT pip one
    // per lap on modulus w.queue while laps rotate TERRITORY on modulus
    // w.terr.length -- the two differ for 8 of 9 mobile stewards, so the lit
    // item and the worked plot were unrelated while drawn on the same figure at
    // the same instant. Worse, it is a progress indicator cycling over a list
    // that provably never drains. Depth is the only honest reading until the
    // roster carries per-item identity.
    const n = Math.min(w.queue, 6);
    for (let i = 0; i < n; i++) S.rect(x + 2 + i * 3, y - 3, 2, 2, '#49525e');
    if (w.queue > 6) S.text(x + 20, y - 4, '+' + (w.queue - 6), '#49525e');

    if (w.state === 'distress') {
      if (blink) S.text(w.px - 11, y + 1, '!', '#f85149');
      S.frost(x, y, 16, 32, PAL.build[11]);   // the lane has produced nothing
    }
    // The green nameplate is GONE: '#3fb950' measures Y=36.33, brighter than
    // #f85149 (26.32) and 4.3x the brightest ground colour, so nine of them
    // were the loudest objects on a canvas whose dusk palette exists to reserve
    // the top of the range for alerts -- and the BAKED idle steward's label was
    // '#49525e' for the same datum. The rail carries every id.
  }

  function draw() {
    // Tick-driven, not wall-clock. 380ms is not a multiple of the tick, so the
    // '!' was held for runs of 2 then 3 frames (2/3/4 on a 120/144Hz panel) --
    // an alert flickering on an irregular beat reads as a rendering fault. Two
    // ticks on, two off = a regular 4Hz/2 = 2Hz at the 125ms tick.
    const blink = ((tick >> 1) & 1) === 0;
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
  // w.mobile, NOT w.queue: mobile is (queue > 0 && the roster is inside its
  // freshness contract). Testing the queue alone would arm the loop for a STALE
  // roster whose workers are all baked -- a spin that draws an unchanging frame
  // 8 times a second, which is the exact battery spend the contract forbids.
  const anyMobile = () => FARM.workers.some(w => w.mobile);
  let onScreen = true;
  const awake = () => !document.hidden && onScreen;
  function frame(now) {
    if (!awake()) { raf = null; return; }   // hidden OR off-screen draws nothing
    // ACCUMULATE, do not reset. `last = now` quantised the tick to the display
    // refresh and never produced 8fps: measured 7.50fps at 60/75/90Hz, 7.67 at
    // 120Hz, 7.85 at 165Hz, so screen speed depended on the panel. Advancing
    // `last` on a 125ms grid holds a true 8.00fps at every rate, and the
    // floor-multiply prevents a catch-up burst after a stall.
    if (now - last >= 125) {
      last += 125 * Math.max(1, Math.floor((now - last) / 125));
      tick++;
      for (const w of FARM.workers) stepWorker(w);
      draw();
    }
    raf = requestAnimationFrame(frame);
  }
  const wake = () => { if (awake() && !raf && anyMobile()) { last = 0; raf = requestAnimationFrame(frame); } };
  const sleep = () => { if (raf) cancelAnimationFrame(raf); raf = null; };
  document.addEventListener('visibilitychange', () => document.hidden ? sleep() : wake());
  // document.hidden is FALSE for a window that is backgrounded but still
  // rendered -- another window on top, a second monitor, a non-focused Space --
  // and for a canvas scrolled out of view. In those states the shipped page
  // animated indefinitely, doing a full-buffer restore plus putImageData plus a
  // scaled drawImage per tick for a canvas nobody is looking at. That is the one
  // remaining path where a battery is spent saying one thing.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(e => { onScreen = e[0].isIntersecting; onScreen ? wake() : sleep(); },
      { threshold: 0.01 }).observe(S.canvas);
  }

  bakeGround();
  // THE NUMBER NOBODY HAS TAKEN. Every frame-rate claim in two sessions has
  // measured the DRAW; the dominant per-frame cost is the full-buffer restore
  // plus putImageData plus a scaled drawImage, and it has never been timed.
  // ?perf=1 prints it instead of asserting it is cheap.
  if (new URLSearchParams(location.search).has('perf')) {
    const t0 = performance.now(); for (let i = 0; i < 30; i++) { S.restoreGround(); S.present(); }
    const ms = (performance.now() - t0) / 30;
    console.log('[perf] restoreGround+present: ' + ms.toFixed(2) + 'ms/frame, buffer '
      + S.w + 'x' + S.h + ', headroom at 8fps: ' + (125 / ms).toFixed(1) + 'x');
  }
  draw();
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
