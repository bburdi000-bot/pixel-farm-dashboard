# Pixel Farm

A 16-bit farm that renders the real state of a software estate — repositories as
fields, departments as buildings, automation as scheduled machines, and the
processes that maintain it all as workers who walk out to a plot, work it, and
walk home.

**[Open the live demo →](https://bburdi000-bot.github.io/pixel-farm-dashboard/)**

Everything on screen is authored as row strings in source. There are no image
files, no webfonts, no npm dependencies and no build step: three `<script>` tags
and a JSON file. `node` alone can verify the whole thing, which is what CI does.

```
index.html          the page
src/engine.js       tile engine: compiled palette blit, 29 authored 16x16 tiles,
                    baked ground layer, packed 4x6 bitmap font
src/sprites.js      16x32 figure (16x24 torso + 4 leg frames), tool frames,
                    building parts, props — 61 items total, all metric-gated
src/farm.js         layout, the baked ground, the commute state machine, the loader
data/               the synthetic demo model (see "The data" below)
tools/              the verifiers CI runs — all four of them are the real gates
```

---

## The one rule everything else follows

**Motion encodes a real event, or it does not happen.**

A worker walks because a queue has items in it. It strikes soil four times per
item because the dwell is a *count*, not a timer. A queue of five draws five
pips and lights one, because the queue on disk has not drained and nothing on
screen may claim it has.

Three consequences, each verified by `tools/verify-commute.js`:

- **A worker with an empty queue is painted into the ground buffer.** Not
  skipped by an `if` — *baked*, so `data.set(ground)` restores it for free, the
  per-frame loop never touches it, and no later edit can accidentally make it
  animate. It is byte-identical after 5000 ticks.
- **An all-idle model schedules zero frames.** `requestAnimationFrame` is never
  armed, `present()` is never called. A farm that has gone still is not a broken
  dashboard; it is the best news the model can carry.
- **A hidden tab draws nothing.** `visibilitychange` cancels the frame.

A permanent 60fps animation is a laptop battery spent saying one thing. This one
runs at **8fps** — the 16-bit cadence — and touches 3.5–4.5% of the buffer per
tick.

## The art direction, measured rather than chosen

`tools/artcheck.js` reads the authored rows straight out of `src/` and fails the
build on any of these. There is no JSON copy of the art to drift out of sync.

| rule | threshold | why |
|---|---|---|
| interior detail | **≥ 12%** of pixels differ from the tile's modal value | a flat `fillRect` reads as a diagram at *any* palette. Authored interiors — blades, furrows, mortar — are the entire difference. Current: grass 16.0%, soil 48.4%, weeds 51.2%, overgrown 35.2%, cobble 38.7% |
| clustering | **≥ 50%** of detail pixels have a 4-neighbour of equal value | isolated single pixels read as noise, which is dither by accident. Current: 89–100% |
| luminance span | **≤ 8** in linearized Rec.709 | ground must stay in the structure register |
| alert headroom | **≥ 15 ΔY** for `#f85149` over every ground surface | currently **+22.15 worst case**. This is why the palette is dusk and not Stardew-daylight: warm daylight grass puts the alert at +7.8 ΔY, isoluminant, and a fault *sinks into the field* |

Two more rules that are structural, not stylistic:

- **Dither is used for exactly one job.** `((x+i)+(y+j)) % d` is a true
  checkerboard only at `d = 2`; at `d ≥ 3` it is continuous 45° stripes —
  blueprint hatch, not texture. So dither is reserved for the frosted
  "cannot be observed" material and is never used as surface detail.
- **Integer everything.** Fractional positions with `|0` snapping produce uneven
  strides, which is the classic pixel-art tell. Every step clamps its final
  increment to land exactly, so stride length is constant.

### Colour carries two independent channels

Hue is identity, luminance is meaning. Worker shirts are tinted per objective —
four ramps — and all four are **isoluminant to 0.00** with the authored blue
(Y = 5.69 / 13.74 / 36.57). Teams are tellable at a glance and the alert channel
is untouched. 11 authored sprite blocks cover every figure: one static torso,
four leg frames, three tool frames, and a free horizontal flip (`w-1-i` on the
read index) instead of a second sheet.

### What the picture says

| on screen | means |
|---|---|
| tilled soil → weeds → overgrown | time since the last write, bucketed. Decay, not growth: fresh ground is *tended*, stale ground is *overgrown* |
| green / amber / red plot label | version-controlled with an off-site copy / on one disk only / not under version control. Three states, because "no backup" and "no version control" are different failures |
| red cross-hatched void | never surveyed. The same material at field scale and at whole-map scale — "cannot see this" is one statement at two sizes |
| amber frame + crate | this is the only copy of it |
| lit / dim / dark window | one per seat: judged healthy / judged unhealthy / **cannot be judged at all** |
| frost (the only dither) | unobservable. A cadence of `on-demand` yields no tolerance, so nothing can ever call that seat unhealthy. It renders frosted, never green — *"unknown" is not a shade of "ok"* |
| a worker whose hoe goes up and never comes down | its objective is a dead lane. Effort with nothing produced may not be drawn striking soil |

## The data

The page asks a local helm for **`/api/farm`** with a 700ms timeout. If nothing
answers, it loads the committed snapshot in `data/` and says **DEMO DATA** in the
header and in the rail. There is no third behaviour: it never invents numbers,
and zero fields renders a **NO MAP** alarm rather than a calm empty farm.

So the same `index.html` is a live dashboard on a workstation and a demo on
GitHub Pages, with no separate build.

**Everything in `data/` is synthetic.** It is generated by
`tools/make-demo.js`, which exists rather than a hand-written JSON blob for two
reasons: it mirrors the real derive rules (decay buckets, the three backup
states, the cadence-tolerance table, the `condemned > sick > unobservable > ok`
health priority), so the fixture cannot drift out of schema; and it asserts
**38 coverage checks** that every visual state is reachable plus a deny-list that
refuses to emit any real identifier. CI runs `--check`, which proves the
committed JSON is the generator's output and was not hand-edited.

No real repository name, department, backlog, verdict, staleness figure or spend
number appears anywhere in this repository, and `.gitignore` plus a CI gate keep
it that way.

### Minimal schema: emit only what something renders

An audit of `src/farm.js` found five fields in the original model that no
renderer path ever reads: per-department staleness and retirement counts, file
and dirty-file counts per repository, and a top-level findings tally. They were
pure payload — and the staleness was the single most sensitive derived number in
the file. The schema in `data/` drops all five. The staleness that *is* shown
reaches the page through `unjudgeableSeats[].age`, which is the honest place for
it, next to the cadence that explains why nothing can judge that seat.

That is the general rule this repo follows: a field that is not drawn is not
published, and a field that is drawn is published next to the thing that makes
it interpretable.

```bash
# the demo, locally — fetch() cannot read relative paths over file://
python3 -m http.server 8080      # then open http://localhost:8080/

?demo=1        force the snapshot even when a helm is running
?demo=nomap    the "registry unreadable" alarm state
```

## Verify it yourself

```bash
node tools/artcheck.js                  # art metrics + the alert-headroom invariant
node tools/make-demo.js --check         # fixtures match their generator
node tools/verify-commute.js            # motion contract across 8 viewports
node tools/render-smoke.js              # executes the real page in a vm sandbox
```

`render-smoke.js` is the interesting one: it runs the three scripts in order
against a stubbed canvas and then asserts things about the pixels that were
actually written — that the live endpoint is tried first, that the buffer comes
back 100% opaque (slot 0 is a hard stencil, never a blend), that a hidden tab
arms exactly one frame and then stops, and that `file://` explains itself instead
of rendering blank. It catches what `node --check` cannot: an undefined global
crossing a `<script>` boundary, or a loader that never reaches `boot()`.

## Licence

MIT. See [LICENSE](LICENSE).
