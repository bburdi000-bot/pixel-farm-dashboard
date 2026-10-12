#!/usr/bin/env node
/* Builds the committed demo fixtures. NOTHING here is read off a real disk.
 *
 * Why a generator and not a hand-written JSON blob: this file mirrors the
 * derive rules in the private build-real.js (neglect buckets, the three soil
 * states, the TOL tolerance table, the condemned>sick>unobservable>ok health
 * priority, the machine state ladder). The fixture therefore cannot drift out
 * of schema with the real model, and a reviewer can check the DERIVED fields
 * by reading the rules rather than trusting the numbers.
 *
 * Output is byte-stable: no Date.now(), no Math.random(), no filesystem reads.
 * `node tools/make-demo.js --check` re-derives and diffs instead of writing,
 * so CI proves the committed fixtures match this source.
 *
 * COVERAGE is asserted at the bottom: every branch the renderer can take must
 * be reachable from these fixtures, or this script exits 1.
 */
'use strict';
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..', 'data');

/* ---- derive rules, identical to the private real-data layer -------------- */
const neglect = d => d == null ? 3 : d < 1 ? 0 : d < 7 ? 1 : d < 30 ? 2 : 3;
const soilOf  = (git, remote) => !git ? 'fallow' : (remote ? 'watered' : 'dry');
const TOL = { continuous: 1, daily: 2, '3x/week': 5, weekly: 10, monthly: 40,
              'on-demand': null, monitor: null };

/* ---- FIELDS: a fictional estate, chosen to cover the state matrix -------- */
// neglect 0/1/2/3 x soil watered/dry/fallow x surveyed t/f x sole t/f.
// Distribution deliberately matches the real model's shape (4 watered,
// 5 dry, 5 fallow, 2 unsurveyed) so the layout and rail counts are identical.
const FIELD_SRC = [
  // id                ring            git  remote surveyed  age   sole
  ['api-gateway',      'Services',     true,  true,  true,     0.2, false],
  ['web-client',       'Services',     true,  true,  true,     0.6, false],
  ['docs-site',        'Content',      true,  true,  true,     3.1, false],
  ['design-tokens',    'Content',      true,  true,  true,     5.4, false],
  ['crm-sync',         'Integrations', true,  false, true,     2.2, false],
  ['batch-jobs',       'Services',     true,  false, true,    12.0, false],
  ['report-builder',   'Analytics',    true,  false, true,    18.5, false],
  ['mail-templates',   'Content',      true,  false, true,    41.0, false],
  ['legacy-importer',  'Archive',      true,  false, true,   180.0, false],
  ['scratch-notes',    'Workspace',    false, false, true,     1.5, false],
  ['media-exports',    'Workspace',    false, false, true,     9.0, false],
  ['sandbox-tmp',      'Workspace',    false, false, false,    0.4, false],
  ['vendor-dumps',     'Archive',      false, false, false,   95.0, true ],
  ['archive-2024',     'Archive',      false, false, true,   240.0, true ],
];
const fields = FIELD_SRC.map(([id, ring, git, remote, surveyed, age, sole]) => ({
  id, ring, neglect: neglect(age), soil: soilOf(git, remote), surveyed, age, sole,
}));

/* ---- BUILDINGS: derived from fictional seats through the real TOL table -- */
// 14 seats across 10 departments, 1 retired -- the real model's shape.
// A cadence of 'on-demand' or 'monitor' yields NO tolerance, so such a seat
// can never be called unhealthy: it renders UNOBSERVABLE (frosted), never ok.
const SEAT_SRC = [
  // dept                label        seat              cadence       staleDays retired
  ['00 Direction',      '00 DIR',    'strategy',       'daily',        0,  false],
  ['01 Build',          '01 BUILD',  'build_owner',    'weekly',      14,  false],
  ['02 Quality',        '02 QA',     'test_owner',     'weekly',      30,  false],
  ['02 Quality',        '02 QA',     'review_board',   'on-demand',   88,  false],
  ['03 Growth',         '03 GROWTH', 'campaigns',      'weekly',      40,  false],
  ['03 Growth',         '03 GROWTH', 'partnerships',   'weekly',      35,  false],
  ['03 Growth',         '03 GROWTH', 'market_watch',   'monitor',     62,  false],
  ['04 Ship',           '04 SHIP',   'release_mgr',    'on-demand',  171,  false],
  ['05 Billing',        '05 BILL',   'invoicing',      'monitor',     94,  false],
  ['06 Infra',          '06 INFRA',  'platform',       'continuous',   0,  false],
  ['06 Infra',          '06 INFRA',  'networking',     'continuous',   0,  false],
  ['07 On-call',        '07 ONCALL', 'primary',        'continuous',   0,  false],
  ['08 Labs',           '08 LABS',   'prototypes',     '3x/week',     20,  false],
  ['99 Sunset',         '99 SUNSET', 'wind_down',      'monthly',      0,  true ],
];
const depts = new Map();
for (const [dept, label, seat, cadence, age, retired] of SEAT_SRC) {
  if (!depts.has(dept)) depts.set(dept, { dept, label, seats: [], bad: 0, unobs: 0, retired: 0 });
  const d = depts.get(dept);
  const tol = TOL[cadence], judgeable = tol != null;
  const sick  = retired ? false : (judgeable && age > tol);
  const unobs = !retired && !judgeable;
  d.seats.push({ seat, cadence, age, sick, unobs, retired });
  if (sick) d.bad++;
  if (unobs) d.unobs++;
  if (retired) d.retired++;
}
// NOTE on what is deliberately ABSENT. An audit of src/farm.js shows the
// renderer never reads buildings[].stale, buildings[].retired, fields[].files,
// fields[].dirty or a top-level detect{} -- they were pure payload in the
// private model. `stale` is the worst of them: a per-department staleness in
// days is the single most sensitive derived number in the real file, and it is
// not drawn. The staleness that IS shown reaches the page through
// unjudgeableSeats[].age, which is the honest place for it. So this fixture
// defines the minimal schema: emit only what something renders.
const buildings = [...depts.values()].map(d => ({
  dept: d.dept, label: d.label,
  seats: d.seats.length, bad: d.bad, unobs: d.unobs,
  // condemned > sick > unobservable > ok. One unjudgeable seat forbids green.
  health: d.retired === d.seats.length ? 'condemned'
        : d.bad   ? 'bad'
        : d.unobs ? 'unobservable' : 'ok',
}));
const unjudgeableSeats = SEAT_SRC
  .filter(([, , , cadence, , retired]) => !retired && TOL[cadence] == null)
  .map(([dept, , seat, cadence, age]) => ({ seat, dept, cadence, age }));

/* ---- WORKERS: 10 stewards. state <- queue depth + dead lanes ------------- */
// 'assurance' is the fictional dead lane, so both its stewards are in distress.
// `desktop` owns three roots that are on NO field, which is what drives the
// off-registry hatched void -- the renderer only walks there when a steward's
// entire territory is missing from the map.
const DEAD_LANES = ['assurance'];
const WORKER_SRC = [
  // id        title                tier objective    queue roots
  ['INDEX',    'Index steward',      1, 'ecosystem',  2, ['api-gateway', 'docs-site']],
  ['PLATFORM', 'Platform steward',   1, 'ecosystem',  3, ['api-gateway', 'batch-jobs', 'sandbox-tmp']],
  ['DESKTOP',  'Desktop steward',    1, 'ecosystem',  3, ['local-inbox', 'local-drafts', 'local-scans']],
  ['RELEASE',  'Release steward',    4, 'delivery',   8, ['web-client', 'docs-site', 'design-tokens']],
  ['ARCHIVE',  'Archive steward',    4, 'delivery',   3, ['archive-2024', 'legacy-importer', 'vendor-dumps']],
  ['CLEANUP',  'Cleanup steward',    4, 'delivery',   4, ['media-exports', 'scratch-notes']],
  ['NOTIFY',   'Notify steward',     3, 'comms',      2, ['mail-templates']],
  ['AUDIT',    'Audit steward',      2, 'assurance',  5, ['report-builder', 'vendor-dumps']],
  ['INTAKE',   'Intake steward',     2, 'assurance',  0, ['crm-sync']],
  ['SURVEY',   'Survey steward',     1, 'ecosystem',  0, ['sandbox-tmp']],
];
const dead = new Set(DEAD_LANES);
const workers = WORKER_SRC.map(([id, title, tier, objective, queue, roots]) => ({
  id, title, tier, objective, queue, roots,
  state: dead.has(objective) ? 'distress' : queue ? 'working' : 'idle',
}));

/* ---- MACHINES: state ladder exactly as the real derive computes it ------- */
//   no declared writes        -> unobservable (nothing to stat)
//   writes declared, none found -> faulted
//   fresh contract, age <= 2x   -> running, else faulted
//   no fresh contract           -> uncontracted
const MACHINE_SRC = [
  // id               sched            writes  ageMin  fresh
  ['healthcheck',    'timer',          true,        5,    30],
  ['metrics-roll',   'timer',          true,       44,   120],
  ['log-ship',       'timer',          true,       61,    90],
  ['index-rebuild',  'timer',          true,      640,   900],
  ['nightly-digest', 'timer',          true,      310,    60],
  ['cache-warm',     'timer',          true,       96,    15],
  ['token-rotate',   'timer',          false,   null,   null],
  ['queue-drain',    'worker',         false,   null,   null],
  ['webhook-relay',  'worker',         true,        7,  null],
  ['feed-fetch',     'hosted-cron',    true,       58,  null],
  ['thumb-gen',      'hosted-cron',    true,       58,  null],
  ['sitemap-ping',   'hosted-cron',    true,       58,  null],
  ['usage-report',   'ci',             true,       44,  null],
  ['link-check',     'ci',             true,      902,  null],
  ['backup-verify',  'timer',          true,     1180,  null],
];
const machines = MACHINE_SRC.map(([id, sched, writes, age, fresh]) => {
  let state;
  if (!writes)            state = 'unobservable';
  else if (age === null)  state = 'faulted';
  else if (fresh)         state = age <= fresh * 2 ? 'running' : 'faulted';
  else                    state = 'uncontracted';
  return { id, state, age, fresh, sched };
});

/* ---- WEATHER / GOLD: fictional charter verdict --------------------------- */
const farm = {
  scanned: '2026-10-11T09:14:00',          // fixed: keeps the fixture byte-stable
  fields, buildings, workers, machines,
  weather: {
    verdict: 'DRIFT',
    breaches: [
      'DEAD LANE: assurance has produced no artifact at all',
      'MISSION FLOOR: tiers 1-3 at 44%, floor is 50%',
      'META CEILING: tier 5 at 29%, ceiling is 25%',
    ],
    mission: 0.44, meta: 0.29,
  },
  gold: { week: 6.4, cap: 25, pct: 26, over: false },
  fallow: fields.filter(f => f.soil === 'fallow').map(f => f.id),
  dry: fields.filter(f => f.soil === 'dry').map(f => f.id),
  unsurveyed: fields.filter(f => !f.surveyed).map(f => f.id),
  unjudgeableSeats,
  demo: true,                              // the page prints a DEMO DATA badge off this
};

/* ---- the second fixture: the map itself is unreadable -------------------- */
// Zero fields does not mean a calm farm, it means the registry could not be
// read. The renderer has a dedicated NO MAP alarm for it and nothing in a
// populated model can reach that branch, so it needs its own fixture.
const nomap = {
  scanned: '2026-10-11T09:14:00',
  fields: [], buildings, workers: workers.map(w => ({ ...w })), machines,
  weather: { verdict: 'DRIFT', breaches: ['NO MAP: registry unreadable'], mission: 0.44, meta: 0.29 },
  gold: farm.gold, fallow: [], dry: [], unsurveyed: [], unjudgeableSeats, demo: true,
};

/* ---- COVERAGE GATE ------------------------------------------------------- */
// Every branch the renderer can take must be reachable from these fixtures.
const have = (label, ok) => ({ label, ok });
const uniq = (a, k) => [...new Set(a.map(k))].sort();
const checks = [
  have('field neglect 0 1 2 3',        uniq(fields,f=>f.neglect).join()==='0,1,2,3'),
  have('field soil dry fallow watered',uniq(fields,f=>f.soil).join()==='dry,fallow,watered'),
  have('field surveyed true + false',  uniq(fields,f=>f.surveyed).length===2),
  have('field sole-copy true + false', uniq(fields,f=>f.sole).length===2),
  have('bld health all four',          uniq(buildings,b=>b.health).join()==='bad,condemned,ok,unobservable'),
  have('window lit reachable',         buildings.some(b=>b.seats-b.bad-b.unobs>0)),
  have('window dim reachable',         buildings.some(b=>b.bad>0)),
  have('window dark reachable',        buildings.some(b=>b.unobs>0)),
  have('worker working idle distress', uniq(workers,w=>w.state).join()==='distress,idle,working'),
  have('queue > 6 (pip overflow)',     workers.some(w=>w.queue>6)),
  have('distress AND mobile (blink)',  workers.some(w=>w.state==='distress'&&w.queue>0)),
  have('distress AND baked (steady)',  workers.some(w=>w.state==='distress'&&w.queue===0)),
  have('idle AND baked',               workers.some(w=>w.state==='idle'&&w.queue===0)),
  have('all-roots-off-map (OFF REG)',  workers.some(w=>w.queue>0&&w.roots.every(r=>!fields.some(f=>f.id===r)))),
  have('4 distinct objectives (gates)',uniq(workers,w=>w.objective).length===4),
  have('machine running',              machines.some(m=>m.state==='running')),
  have('machine faulted',              machines.some(m=>m.state==='faulted')),
  have('machine unobservable',         machines.some(m=>m.state==='unobservable')),
  have('machine uncontracted',         machines.some(m=>m.state==='uncontracted')),
  have('weather breaches non-empty',   farm.weather.breaches.length>0),
  have('NO MAP fixture has 0 fields',  nomap.fields.length===0),
];
// PROVENANCE, as an ALLOW-LIST rather than a deny-list. A deny-list would have
// to spell the private identifiers out in a public file, which is itself the
// leak it is trying to prevent. So instead: every string that reaches the
// output must be traceable to a literal declared ABOVE in this file, or to the
// renderer's own structural vocabulary. Anything else -- a stray paste, an
// accidental require of the real derive layer -- fails the build without this
// file ever naming what it is protecting against.
const DECLARED = new Set();
for (const row of FIELD_SRC)   for (const v of row) DECLARED.add(String(v));
for (const row of SEAT_SRC)    for (const v of row) DECLARED.add(String(v));
for (const row of WORKER_SRC)  { for (const v of row.slice(0, 5)) DECLARED.add(String(v));
                                 for (const r of row[5]) DECLARED.add(String(r)); }
for (const row of MACHINE_SRC) for (const v of row) DECLARED.add(String(v));
for (const b of DEAD_LANES)    DECLARED.add(b);
// the renderer's own vocabulary: derived enum values and fixed strings
const STRUCTURAL = new Set([
  'tended','fine','weeds','overgrown', 'fallow','dry','watered',
  'ok','bad','unobservable','condemned', 'working','idle','distress',
  'running','faulted','uncontracted', 'DRIFT','OK',
  '2026-10-11T09:14:00',
  'DEAD LANE: assurance has produced no artifact at all',
  'MISSION FLOOR: tiers 1-3 at 44%, floor is 50%',
  'META CEILING: tier 5 at 29%, ceiling is 25%',
  'NO MAP: registry unreadable',
]);
const strings = [];
(function walk(v) {
  if (typeof v === 'string') strings.push(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') for (const k in v) walk(v[k]);
})([farm, nomap]);
const stray = [...new Set(strings)].filter(s => !DECLARED.has(s) && !STRUCTURAL.has(s));
checks.push(have(`every output string is declared in this file (${strings.length} strings, `
  + `${DECLARED.size} declared)`, stray.length === 0));
if (stray.length) console.error('  STRAY STRINGS: ' + JSON.stringify(stray));

let bad = 0;
for (const c of checks) { if (!c.ok) bad++; console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.label}`); }
console.log(bad ? `\n${bad} COVERAGE CHECK(S) FAILED` : '\nALL COVERAGE CHECKS PASS');
if (bad) process.exit(1);

/* ---- write or verify ----------------------------------------------------- */
const files = [['farm-demo.json', farm], ['farm-demo-nomap.json', nomap]];
const check = process.argv.includes('--check');
let drift = 0;
for (const [name, obj] of files) {
  const fp = path.join(OUT, name), text = JSON.stringify(obj, null, 2) + '\n';
  if (check) {
    const cur = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
    if (cur !== text) { console.error(`DRIFT: ${name} does not match tools/make-demo.js`); drift++; }
    else console.log(`  ok    ${name} matches generator`);
  } else { fs.writeFileSync(fp, text); console.log(`  wrote ${name}  (${text.length} bytes)`); }
}
if (drift) process.exit(1);
console.log(`\nfields ${fields.length}  buildings ${buildings.length}  workers ${workers.length}  machines ${machines.length}`);
console.log('health   ' + ['ok','bad','unobservable','condemned'].map(h=>h+' '+buildings.filter(b=>b.health===h).length).join('  '));
console.log('machines ' + ['running','faulted','unobservable','uncontracted'].map(s=>s+' '+machines.filter(m=>m.state===s).length).join('  '));
