/* Authored art. 16x32 characters, 1 tile wide and 2 tall -- the proportion the
 * target style uses, and the width is what carries readability: at 12px you get
 * ~3px of head and 2px per arm, which cannot hold ten distinguishable figures.
 *
 * AUTHORING ECONOMY: one static 16x24 torso plus four 16x8 leg frames, rather
 * than four directions x four frames of whole bodies. 4 leg strings instead of
 * 16 full sprites. Horizontal flip is free (w-1-i on the read index), so the
 * right-facing sheet serves left.
 *
 * KEY-LINE: every figure carries a 1px #0e1014 outline. Without it a sprite
 * placed on grass, soil or cobble reads differently on each -- the outline is
 * what makes one sprite legible on every ground, and it is why the figures do
 * not need to be bright (which would spend the alert luminance headroom).
 */

// ---- torso: rows 0-23, worn by every frame -------------------------------
const TORSO = [
  '................',
  '.....222222.....',
  '....23333332....',
  '....23333332....',
  '....24444442....',
  '....45555554....',
  '....41555514....',
  '....45555554....',
  '.....144441.....',
  '......4444......',
  '..167777777761..',
  '..167788887761..',
  '..167788887761..',
  '..167777777761..',
  '..166677776661..',
  '..146677776641..',
  '....177777771...',
  '.....19999991...',
  '.....1a9999a1...',
  '.....1a9999a1...',
  '.....19999991...',
  '......199991....',
  '......199991....',
  '......199991....',
];

// ---- legs: rows 24-31. Four frames of a walk cycle -----------------------
const LEGS = [
  // 0 contact
  ['....1aa1.1aa1...','....1aa1.1aa1...','....1aa1.1aa1...','....1aa1.1aa1...',
   '....1991.1991...','....1991.1991...','....1111.1111...','...11111.11111..'],
  // 1 passing (legs together)
  ['.....1aa11aa1...','.....1aa11aa1...','.....1aa11aa1...','.....1aa11aa1...',
   '.....199119911..','.....199119911..','.....111111111..','.....111111111..'],
  // 2 contact opposite (stride)
  ['...1aa1...1aa1..','...1aa1...1aa1..','..1aa1.....1aa1.','..1aa1.....1aa1.',
   '..1991.....1991.','.1991.......1991','.1111.......1111','11111.......1111'],
  // 3 passing
  ['.....1aa11aa1...','.....1aa11aa1...','.....1aa11aa1...','.....1aa11aa1...',
   '.....199119911..','.....199119911..','.....111111111..','.....111111111..'],
];

// ---- arms: a tool-swing overlay, 3 frames, drawn over the torso ----------
// Only used when a worker is WORKING, so the hoe exists only while a real
// write is being represented.
const TOOLS = [
  // raised
  ['..............bb','.............bbc','............bb..','...........bb...',
   '..........bb....','.........bb.....','........4b......','.......44.......'],
  // mid
  ['................','..............bb','.............bbc','...........bbb..',
   '.........bbb....','.......4bb......','......44........','................'],
  // struck (into the soil)
  ['................','................','................','.............bb.',
   '...........bbc..','.........4bb....','........44......','.......cc.......'],
];

// ---- building parts: authored, tiled horizontally so width can vary ------
const PARTS = {
  // 16x8 shingle course. Staggered, with a lit top edge: that stagger is what
  // separates a roof from a filled rectangle.
  roof: [
    '6666666666666666',
    '5445445445445445',
    '5445445445445445',
    '4554554554554554',
    '4554554554554554',
    '5445445445445445',
    '5445445445445445',
    '7777777777777777',
  ],
  // 16x8 plank course with vertical joins
  wall: [
    '3333333333333333',
    '2222222222222222',
    '2212222122122212',
    '2222222222222222',
    '1111111111111111',
    '2222222222222222',
    '2122122212221222',
    '2222222222222222',
  ],
  door: [
    '177771','133331','132231','132231','132231',
    '132231','132231','137231','133331','177771',
  ],
  winLit:  ['17771','18881','18881','17771'],
  winDim:  ['17771','19991','19991','17771'],
  winDark: ['17771','1aaa1','1aaa1','17771'],
  // a lamp post: the ONE warm accent in the scene
  lamp: ['.888.','18881','.888.','..7..','..7..','..7..','..7..','.777.'],
};

// ---- props ---------------------------------------------------------------
const PROPS = {
  // a machine shed: small, so 15 of them do not compete with 10 buildings
  shed: ['.6666666.','655555556','544444445','722222227','721222127','722222227','777777777'],
  // sole-copy marker: a crate, not a letter
  crate: ['7777','7337','7337','7777'],
};

function compileAll() {
  const out = { legs: [], tools: [], parts: {}, props: {} };
  // full 32-row frames: torso + each leg frame
  out.frames = LEGS.map(l => compile(TORSO.concat(l)));
  out.tools = TOOLS.map(t => compile(t));
  for (const k in PARTS) out.parts[k] = compile(PARTS[k]);
  for (const k in PROPS) out.props[k] = compile(PROPS[k]);
  return out;
}

/* Dual-mode tail -- see src/engine.js. compileAll() is NOT called here; it
 * needs engine.js's compile() from the shared script scope, which only exists
 * in the browser. Node consumers read the raw authored rows. */
if (typeof module !== 'undefined' && module.exports)
  module.exports = { TORSO, LEGS, TOOLS, PARTS, PROPS };
