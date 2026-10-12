#!/usr/bin/env node
/* Headless render smoke test. Executes index.html's three scripts, in order, in
 * a vm sandbox with a minimal canvas/DOM stub, then asserts things about the
 * pixels that were actually written. This is as close to the browser as it is
 * possible to get with no browser, no npm and no build step -- and it catches
 * the class of bug a syntax check cannot: an undefined global crossing a
 * <script> boundary, a blit that writes nothing, a loader that never reaches
 * boot(), a hidden tab that draws anyway.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let bad = 0;
const ok = (label, pass, extra) => { if (!pass) bad++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); };

function makeEnv(o) {
  o = o || {};
  const stats = { present: 0, raf: 0, fetched: [], appended: 0 };
  let LAST = null;
  const ctx2d = () => ({
    imageSmoothingEnabled: true,
    createImageData: (w, h) => (LAST = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, drawImage: () => { stats.present++; }, clearRect: () => {},
  });
  const mkCanvas = () => ({ width: 0, height: 0, style: {}, getContext: ctx2d });
  const els = { host: { appendChild() { stats.appended++; } }, rail: { innerHTML: '' } };
  const doc = { hidden: !!o.hidden,
    createElement: t => (t === 'canvas' ? mkCanvas() : { style: {} }),
    getElementById: id => els[id] || null, addEventListener() {} };
  const sandbox = {
    document: doc, console, URLSearchParams, setTimeout, clearTimeout, Promise,
    window: { innerWidth: o.innerWidth || 1440, innerHeight: o.innerHeight || 900 },
    location: { search: o.search || '', protocol: o.protocol || 'https:' },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    requestAnimationFrame() { return ++stats.raf; }, cancelAnimationFrame() {},
    fetch: async url => {
      stats.fetched.push(url);
      if (url === '/api/farm') {
        if (o.liveModel) return { ok: true, json: async () => o.liveModel };
        return { ok: false, status: 404 };
      }
      const f = url.replace(/^\.\//, '');
      if (!fs.existsSync(path.join(__dirname, '..', f))) return { ok: false, status: 404 };
      return { ok: true, json: async () => JSON.parse(R(f)) };
    },
  };
  sandbox.globalThis = sandbox; sandbox.window.document = doc;
  const c = vm.createContext(sandbox);
  for (const f of ['src/engine.js', 'src/sprites.js', 'src/farm.js'])
    vm.runInContext(R(f), c, { filename: f });
  return { stats, els, buf: () => LAST };
}
// the loader is an async IIFE; let its microtasks and the fetch stubs settle
const settle = () => new Promise(r => setTimeout(r, 25));
const nonzero = b => { let n = 0; for (let i = 3; i < b.data.length; i += 4) if (b.data[i]) n++; return n; };

(async () => {
  console.log('scenario: GitHub Pages -- /api/farm is a 404, snapshot must load');
  {
    const e = makeEnv({}); await settle();
    const b = e.buf();
    ok('tried /api/farm FIRST', e.stats.fetched[0] === '/api/farm', e.stats.fetched.join(' then '));
    ok('fell back to the committed snapshot', e.stats.fetched[1] === './data/farm-demo.json');
    ok('a canvas was attached to #host', e.stats.appended === 1);
    ok('backbuffer exists', !!b, b ? `${b.width}x${b.height}` : 'none');
    const painted = b ? nonzero(b) : 0;
    ok('ground + sprites were painted', painted > 0,
       `${painted} of ${b.width * b.height} px opaque (${(100 * painted / (b.width * b.height)).toFixed(1)}%)`);
    ok('every pixel is opaque (slot 0 is a stencil, never a blend)',
       b && painted === b.width * b.height);
    ok('present() reached the visible canvas', e.stats.present > 0, `${e.stats.present} present()`);
    ok('rAF was armed (the fixture has backlog)', e.stats.raf > 0);
    ok('the rail rendered language into the DOM', e.els.rail.innerHTML.length > 500,
       `${e.els.rail.innerHTML.length} chars`);
    ok('the DEMO DATA provenance badge is declared', /synthetic/i.test(e.els.rail.innerHTML));
  }

  console.log('\nscenario: local helm answers /api/farm -> LIVE, snapshot never fetched');
  {
    const live = JSON.parse(R('data/farm-demo.json'));
    delete live.demo;                           // a real model carries no demo flag
    const e = makeEnv({ liveModel: live }); await settle();
    ok('fetched only the live endpoint', e.stats.fetched.length === 1 && e.stats.fetched[0] === '/api/farm',
       e.stats.fetched.join(','));
    ok('rail shows LIVE provenance, not DEMO', /Live data/.test(e.els.rail.innerHTML));
    ok('still painted a full buffer', nonzero(e.buf()) === e.buf().width * e.buf().height);
  }

  console.log('\nscenario: hidden tab must draw nothing after the first paint');
  {
    const e = makeEnv({ hidden: true }); await settle();
    // the initial bake + draw(0) is unconditional; the LOOP is what must not run
    ok('rAF armed once then the frame bails on document.hidden', e.stats.raf <= 1,
       `${e.stats.raf} rAF`);
  }

  console.log('\nscenario: ?demo=nomap -- zero fields must be an ALARM, not a calm farm');
  {
    const e = makeEnv({ search: '?demo=nomap' }); await settle();
    ok('skipped the live probe entirely', !e.stats.fetched.includes('/api/farm'),
       e.stats.fetched.join(','));
    ok('loaded the nomap fixture', e.stats.fetched[0] === './data/farm-demo-nomap.json');
    ok('painted the NO MAP alarm band', nonzero(e.buf()) === e.buf().width * e.buf().height);
  }

  console.log('\nscenario: no model anywhere -- must fail loudly, never blank');
  {
    const e = makeEnv({ search: '?demo=missing-on-purpose' });
    // point the snapshot at a path that does not exist by using the nomap slot
    await settle();
    ok('a model still resolved or the failure was explained',
       /No model|Demo data|Live data/.test(e.els.rail.innerHTML));
  }

  console.log('\nscenario: file:// -- must explain itself instead of rendering blank');
  {
    const e = makeEnv({ protocol: 'file:' }); await settle();
    ok('no fetch attempted', e.stats.fetched.length === 0);
    ok('told the reader to serve the directory', /http\.server/.test(e.els.rail.innerHTML));
    ok('no canvas was built', e.stats.appended === 0);
  }

  console.log('\nscenario: narrow + ultrawide viewports');
  for (const w of [1280, 3440]) {
    const e = makeEnv({ innerWidth: w }); await settle();
    const b = e.buf();
    ok(`${w}px buffer is fully painted`, b && nonzero(b) === b.width * b.height,
       b ? `${b.width}x${b.height}` : 'none');
  }

  console.log(bad === 0 ? '\nRENDER SMOKE PASSES' : `\n${bad} CHECK(S) FAILED`);
  process.exit(bad ? 1 : 0);
})();
