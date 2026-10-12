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
  '.....333221.....',
  '....333332221...',
  '....355544221...',
  '....155524421...',
  '....155524421...',
  '....155544421...',
  '.....1554421....',
  '.....144421.....',
  '......1441......',
  '...8877777661...',
  '..188777776661..',
  '..188777776661..',
  '..188777776661..',
  '..188777776661..',
  '..158777776661..',
  '...1877777661...',
  '....1aa999991...',
  '....1aa999991...',
  '....1aa999991...',
  '....1aa99991....',
  '.....1aa9991....',
  '.....1aa9991....',
  '.....1aa9991....',
];

// ---- legs: rows 24-31. Four frames of a walk cycle -----------------------
const LEGS = [
  // contact
  [
    '....1a91.1a91...',
    '....1a91.1a91...',
    '....1a91.1a91...',
    '....1a91.1a91...',
    '....1a91.1a91...',
    '....1a91.1a91...',
    '....1111.1111...',
    '...11111.11111..',
  ],
  // passing
  [
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a911..',
    '.....1a911a911..',
    '.....111111111..',
    '.....111111111..',
  ],
  // stride
  [
    '...1a91...1a91..',
    '...1a91...1a91..',
    '..1a91.....1a91.',
    '..1a91.....1a91.',
    '..1a91.....1a91.',
    '.1a91.......1a91',
    '.1111.......1111',
    '11111.......1111',
  ],
  // passing
  [
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a91...',
    '.....1a911a911..',
    '.....1a911a911..',
    '.....111111111..',
    '.....111111111..',
  ],
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
  // EMITTER: the scene has exactly ONE light source, so exactly one material
  // is allowed above the alert floor. Outlined on all four sides, which the
  // retired 5x8 lamp was not -- it bled into whatever was behind it.
  lanternHead: [
    '.77777.',
    '7888887',
    '7889887',
    '7888887',
    '.77777.',
    '..777..',
  ],
  // 16x8 shingle course. Staggered, with a lit top edge: that stagger is what
  // separates a roof from a filled rectangle.
  // 16x8 plank course with vertical joins
  door: [
    '177771','133331','132231','132231','132231',
    '132231','132231','137231','133331','177771',
  ],
  winLit:  ['17771','18881','18881','17771'],
  winDim:  ['17771','19991','19991','17771'],
  winDark: ['17771','1aaa1','1aaa1','17771'],
  // a lamp post: the ONE warm accent in the scene
  roofC: [
    '6655665566556655',
    '4455445544554455',
    '5544554455445544',
    '4455445544554455',
    '5544554455445544',
    '4455445544554455',
    '5544554455445544',
    '7777777777777777',
  ],
  wallClap: [
    '3332333332333233',
    '2221222212221221',
    '2221222212221221',
    '1112111121112112',
    '3233332333323333',
    '2122221222212222',
    '2122221222212222',
    '1211112111121111',
  ],
};

// ---- props ---------------------------------------------------------------
const PROPS = {
  // the machine shed, kept: blitted with PALC.build by the machine strip
  shed: [
    '.6666666.',
    '655555556',
    '544444445',
    '722222227',
    '721222127',
    '722222227',
    '777777777',
  ],
  shadMid: [
    'eeeeeeee',
    'eeeeeeee',
    'ffffffff',
  ],
  shadCapL: [
    '..e',
    '.ee',
    '.ff',
  ],
  shadShed: [
    '.eeeeeeeee.',
    'eeeeeeeeeee',
    '.fffffffff.',
    '...fffff...',
  ],
  crateBig: [
    'eeeeeeeeeeee',
    'e66e6666e66e',
    'e55e6666e55e',
    'e55e5555e55e',
    'eeeeeeeeeeee',
    'e65e6666e65e',
    'e55e5555e55e',
    'eeeeeeeeeeee',
    'e55e6666e55e',
    'e44e4444e44e',
    '.ffffffffff.',
  ],
  lanternPost: [
    '.......',
    '.......',
    '.......',
    '.......',
    '.......',
    '.......',
    '.e999e.',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '..98e..',
    '.9998e.',
    'e99888e',
    '.fffff.',
  ],
  tree: [
    '....bbbbb....',
    '..bbbbbbbbb..',
    '.bbbbbbbbaaa.',
    'bbbbbbbbaaaae',
    'bbbbbbbaaaaae',
    'bbbbbbaaaaaae',
    '.bbbbaaaaaae.',
    '..bbaaaaaae..',
    '...aaaaaae...',
    '.....654.....',
    '.....654.....',
    '.....654.....',
    '.....654.....',
    '....66544....',
    '...665444....',
    '..fffffffff..',
  ],
  bush: [
    '..bbbbb..',
    '.bbbbaaa.',
    'bbbbaaaae',
    'bbbaaaaae',
    '.bbaaaae.',
    '..aaaae..',
    '..fffff..',
  ],
  stump: [
    '.66655.',
    '6665544',
    '665554e',
    '655544e',
    '.5544e.',
    '.fffff.',
  ],
  rock: [
    '..999..',
    '.99888.',
    '9988887',
    '.88877e',
    '.fffff.',
  ],
  rockSmall: [
    '.99..',
    '98887',
    '.887e',
    '.fff.',
  ],
  fencePost: [
    '65e',
    '65e',
    '65e',
    '65e',
    '65e',
    '65e',
    '65e',
    '.f.',
  ],
  fenceRail: [
    '6666666666666666',
    '5555555555555555',
    'eeeeeeeeeeeeeeee',
    '................',
  ],
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
