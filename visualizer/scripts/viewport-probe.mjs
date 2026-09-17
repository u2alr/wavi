#!/usr/bin/env node
/**
 * Responsive layout probe.
 *
 * Drives a real Chrome at phone/tablet/desktop viewports over the DevTools
 * protocol and reports what actually breaks: elements escaping the viewport,
 * children spilling out of their container, clipped labels, tap targets under
 * 24px, off-screen regions, error-boundary fallbacks. Also taps the panel
 * drawer handle to prove the narrow-viewport controls are reachable.
 *
 * It also sweeps every preset id (--presets, on by default) against the app's
 * own list in src/presets.ts. That sweep is the only check here that can catch a
 * shader that fails to compile: three.js reports GLSL compile/link failures with
 * console.error and carries on drawing a black frame, so nothing throws and no
 * error boundary fires. A preset fails on a console or GL error, a canvas with
 * no WebGL context, a Suspense fallback that never resolved, or a #p= deep link
 * that did not actually switch the preset.
 *
 * Each swept preset is also captured as a 16x16 grid of average cell colour and
 * compared against the committed reference frame in scripts/probe-baselines/.
 * That catches what compiling and mounting does not: a black or blank frame, the
 * wrong palette, a shader that stopped responding to its parameters. It is
 * deliberately coarse — CI renders on SwiftShader and a developer's machine on a
 * real GPU, and per-pixel noise differs between the two while the structure does
 * not — so subtle regressions still need eyes on the actual thing.
 *
 * The sweep feeds the presets a fixed synthetic spectrum, posted the way the
 * browser extension posts it, and runs a virtual clock that stops at a fixed
 * animation time. Both are needed: four presets (amPreset, am2Preset, waveform,
 * chromaticBurst) draw nothing at all without a signal, and on a real clock every
 * band-reactive preset would sit somewhere different on each run. Every swept
 * preset is compared; RENDERER_SENSITIVE below is empty, and records what used to
 * be in it and why that was a shader bug rather than a property to live with.
 *
 * Why this exists: `@media` rules here are spread over nine stylesheets imported
 * in a load-bearing order, so a same-specificity rule in theme.css silently kills
 * a touch rule in responsive.css with no build error. Only a real engine can
 * tell you which one won.
 *
 * No test-runner or browser-automation dependency — plain Node + Chrome.
 *
 *   npm run check:viewport
 *   npm run check:viewport -- --sizes 320x568,768x1024 --pointer both
 *   npm run check:viewport -- --server preview --sizes 390x844   # built bundle
 *   npm run --silent check:viewport -- --json > report.json   # --silent: npm's
 *                                                            # banner breaks the JSON
 *   npm run check:viewport -- --presets none      # layout checks only
 *   npm run check:viewport -- --presets acidWash,brat
 *   npm run check:viewport -- --update-baselines  # after an intended look change
 *   npm run check:viewport -- --software-gl       # render like CI does
 *
 * Exit code is 1 when a failure-level finding is present (0 with --json unless
 * --fail is passed), which is how CI gates on it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CDP_PORT = 9333
const SERVER_PORTS = { dev: 5173, preview: 4173 }
const DEFAULT_SIZES = [
  ['360x640', 360, 640, 2], // small Android
  ['390x844', 390, 844, 3], // iPhone 14
  ['430x932', 430, 932, 3], // iPhone Pro Max
  ['844x390', 844, 390, 2], // phone, landscape
  ['1024x768', 1024, 768, 2], // tablet
  ['1440x900', 1440, 900, 1], // desktop
]
// Below this a touch target is a failure; below COMFORT a warning (WCAG 2.5.8
// is 24; 44 is the comfortable touch guideline).
const MIN_TARGET = 24
const COMFORT_TARGET = 44

/* ── args ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
/** Accepts both `--name=value` and `--name value`. */
const flag = (name, fallback) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  const next = at === -1 ? undefined : argv[at + 1]
  return next && !next.startsWith('--') ? next : fallback
}
const has = (name) => argv.includes(`--${name}`)

if (has('help')) {
  console.log(`
Usage: npm run check:viewport -- [options]

  (Options take either --name=value or --name value.)

  --server=<mode>      dev (default) spawns the vite dev server; preview
                       spawns the vite preview server, i.e. probes the built
                       bundle (run npm run build first).
  --url=<url>          Page to probe (default http://127.0.0.1:<port>/).
                       An already-running server is reused; otherwise the one
                       from --server is started and stopped afterwards.
  --port=<number>      Port (default 5173 for dev, 4173 for preview).
  --sizes=<list>       Comma-separated WxH list, e.g. 320x568,768x1024.
  --pointer=<mode>     touch (default) | mouse | both.
  --no-audio           Skip loading audio fixtures. The player box and its
                       transport only exist with a track loaded, so this hides
                       the most useful measurements.
  --presets=<list>     all (default) | none | comma-separated preset ids.
                       Renders each preset at a fixed 390x844 touch viewport and
                       fails on a shader, GL or console error. The ids are read
                       from src/presets.ts, so a new preset is swept without
                       editing this script.
  --update-baselines   Rewrite scripts/probe-baselines/ from this run instead of
                       comparing against it. Use after an intended change to how
                       a preset looks, or to the synthetic signal, then commit
                       the files.
  --software-gl        Force Chrome onto SwiftShader. That is what CI renders
                       with, so this is how the reference frames are checked for
                       renderer independence.
  --json               Machine-readable output.
  --strict             Also fail on info-level findings (clipped labels,
                       targets under ${COMFORT_TARGET}px).
  --fail               With --json, exit 1 on failure-level findings.
`)
  process.exit(0)
}

const SERVER = flag('server', 'dev')
if (!(SERVER in SERVER_PORTS)) throw new Error(`unknown --server: ${SERVER}`)
const PORT = Number(flag('port', SERVER_PORTS[SERVER]))
const URL = flag('url', `http://127.0.0.1:${PORT}/`)
const POINTERS =
  flag('pointer', 'touch') === 'both' ? ['touch', 'mouse'] : [flag('pointer', 'touch')]
const SIZES = (() => {
  const raw = flag('sizes', '')
  if (!raw) return DEFAULT_SIZES
  return raw.split(',').map((entry) => {
    const [w, h] = entry.trim().split('x').map(Number)
    if (!w || !h) throw new Error(`bad --sizes entry: ${entry}`)
    return [`${w}x${h}`, w, h, w > 1000 ? 1 : 2]
  })
})()
const LOAD_AUDIO = !has('no-audio')
const JSON_OUT = has('json')
const STRICT = has('strict')
const UPDATE_BASELINES = has('update-baselines')
const SOFTWARE_GL = has('software-gl')

/* ── presets ────────────────────────────────────────────────────────── */

/**
 * The preset ids come from the app's own list rather than a copy here, so a
 * preset added later is swept without anyone remembering to extend this script.
 */
function readPresetIds() {
  const file = join(process.cwd(), 'src/presets.ts')
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`cannot read ${file} — pass --presets=<id,id> or --presets=none`)
  }
  const block = source.match(/PRESET_TYPES[^=]*=\s*\[([\s\S]*?)\]/)
  const ids = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  if (!ids.length) throw new Error(`no preset ids in ${file} — pass --presets=<id,id>`)
  return ids
}

/** Canonical id order, needed to interpret the Presets menu below. */
let PRESET_IDS = []
let presetListError = null
try {
  PRESET_IDS = readPresetIds()
} catch (err) {
  presetListError = err
}

const PRESETS = (() => {
  const raw = flag('presets', has('no-presets') ? 'none' : 'all')
  if (raw === 'none' || raw === 'false') return []
  if (raw === 'all' || raw === 'true') {
    if (presetListError) throw presetListError
    return PRESET_IDS
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
})()
// One fixed viewport for the whole sweep, deliberately not the first --sizes
// entry: a captured frame is only comparable to a reference captured at the same
// size, so the capture size has to be a constant rather than a function of the
// flags. Change it and the reference frames need regenerating.
const SWEEP = { pointer: 'touch', size: ['390x844', 390, 844, 2] }

/* ── reference frames ───────────────────────────────────────────────── */

// Frames are compared as a GRID x GRID grid of average cell colour, not as
// pixels: CI has no GPU and renders through SwiftShader, where per-pixel noise
// lands differently than on real hardware, while the coarse structure of a frame
// is very nearly identical.
const GRID = 16
// Per-channel, on a cell average. Well above renderer-to-renderer drift and far
// below an actual visual change.
const TOLERANCE = 12
// ...and a few cells are allowed past it anyway. Currently dormant: measured on
// both a Radeon and SwiftShader against these references, no cell of any preset
// is past the tolerance above (worst 9 across renderers, 1 on the renderer the
// frames were captured on). It is headroom rather than a fix for a case that
// exists, because those two renderers are not every renderer: a thin
// high-contrast feature can land inside a cell on one driver and on the boundary
// on another, which reads as a large delta in that single cell while leaving the
// rest of the frame untouched — sub-pixel phase, not a difference anyone can see.
// What it costs: a change confined to a small part of the frame can hide in the
// allowance.
const OUTLIER_FRACTION = 0.08
const ALLOWED_CELLS = Math.round(GRID * GRID * OUTLIER_FRACTION)
const BASELINE_DIR = 'scripts/probe-baselines'
// The sweep runs a virtual clock: performance.now() advances by a fixed step per
// animation frame and stops at a fixed total (see VIRTUAL_CLOCK). Every preset
// drives its uTime from state.clock.elapsedTime, which three reads from
// performance.now(), and the analysis engine's envelopes advance off the same
// value — on a real clock both would sit wherever the machine happened to be,
// and two runs of identical code would not match. 12s of virtual time is far
// enough in for the patterns and the followers to have settled.
const VIRTUAL_STEP_MS = 200
const CAPTURE_FRAMES = 60
const CAPTURE_CLOCK_MS = VIRTUAL_STEP_MS * CAPTURE_FRAMES

/**
 * The audio the sweep renders with, posted the way the browser extension posts
 * it — the app listens for exactly this shape (App.tsx, 'visualizer-audio-
 * extension'). Deterministic by construction: a fixed formula, no randomness, no
 * decoder, no playback position. Playing a real file instead would leave every
 * band-reactive preset at a different point in the track on every run.
 *
 * A music-shaped spectrum, so the seven visual bands differ from each other
 * rather than all reading one number, and a two-component waveform so the AM and
 * waveform presets have a trace worth drawing.
 */
/** Level the preset band maths reads back: bass 0.74, mid 0.28, treble 0.08. */
const SYNTHETIC_AUDIO = (() => {
  const bins = []
  for (let i = 0; i < 256; i++) {
    const tilt = Math.exp(-i / 55)
    const ripple = 0.5 + 0.5 * Math.sin(i / 9.5)
    bins.push(Math.round(10 + 235 * tilt * (0.6 + 0.4 * ripple)))
  }
  const wave = []
  for (let i = 0; i < 2048; i++) {
    const t = i / 2048
    const v = 0.62 * Math.sin(2 * Math.PI * 3 * t) + 0.24 * Math.sin(2 * Math.PI * 7 * t + 0.7)
    wave.push(Math.round(128 + 112 * v))
  }
  return { signal: 190, bins, wave }
})()

const baselinePath = (preset) => join(BASELINE_DIR, `${preset}.json`)
/** Same path in the shape it is written in the repo, for messages. */
const baselineLabel = (preset) => `${BASELINE_DIR}/${preset}.json`

function readBaseline(preset) {
  try {
    return JSON.parse(readFileSync(baselinePath(preset), 'utf8'))
  } catch {
    return null
  }
}

/** One grid row per line: the file is meant to be reviewable in a diff. */
function writeBaseline(preset, rows, renderer) {
  mkdirSync(BASELINE_DIR, { recursive: true })
  const body = rows.map((row) => `    [${row.map((c) => `[${c.join(', ')}]`).join(', ')}]`).join(',\n')
  const meta = [
    ['preset', JSON.stringify(preset)],
    ['size', JSON.stringify(SWEEP.size[0])],
    ['grid', String(GRID)],
    ['renderer', JSON.stringify(renderer ?? 'unknown')],
    // The captured frame depends on the signal, so record which one it was.
    ['audio', JSON.stringify('synthetic')],
  ]
  const head = meta.map(([k, v]) => `  "${k}": ${v}`).join(',\n')
  writeFileSync(baselinePath(preset), `{\n${head},\n  "rows": [\n${body}\n  ]\n}\n`)
}

/**
 * Presets whose rendered frame differs between GL implementations, so they have
 * no committed reference to compare against: CI renders through SwiftShader and
 * the references are captured on a GPU.
 *
 * Empty. Its only member was auroraSilk, and how it got here is worth keeping
 * because the same bug will look nothing like it next time. auroraSilk's smoke
 * field is a three-deep fbm whose hash was the familiar
 *
 *   fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123)
 *
 * which evaluates sin() on an argument in the hundreds and multiplies by ~4.4e4.
 * GL leaves the accuracy of sin() at large arguments to the implementation, so
 * that factor turned a range-reduction difference of a few units in the last
 * place into a different hash cell: the noise field decorrelated and whole
 * regions flipped across its smoke threshold. It measured 235 of 256 cells
 * differing by up to 175/255 between a Radeon and SwiftShader, against 9 or less
 * for every other preset. Three captures of it on one renderer were
 * byte-identical, so that was the renderer and not the probe.
 *
 * It is fixed rather than exempted. auroraSilk now hashes without a sine — the
 * +, *, dot and fract form, which every implementation evaluates identically (see
 * the comment in AuroraSilkPreset.tsx). The same measurement afterwards is 0
 * cells past tolerance, worst 9.
 *
 * So prefer fixing the shader, and reach for this list only for a preset that is
 * genuinely renderer-dependent and cannot be made not to be. It exists so that
 * such a preset is reported as *not compared* on every run rather than quietly
 * counting as covered. To measure one: run the sweep on both renderers with
 * --json and diff the `frame` fields —
 *   npm run check:viewport -- --presets <id> --json
 *   npm run check:viewport -- --presets <id> --json --software-gl
 */
const RENDERER_SENSITIVE = new Set([])

/**
 * True for a frame that is uniformly black, i.e. the preset drew nothing. That
 * is what a preset needing audio looked like before the sweep had any — a state
 * the run reports rather than calls a pass.
 */
const isBlank = (rows) => rows.every((row) => row.every((c) => c[0] <= 4 && c[1] <= 4 && c[2] <= 4))

/** Cells past TOLERANCE between two frames, plus the worst one. */
function compareFrames(want, got) {
  let past = 0
  let worst = null
  for (let y = 0; y < want.length; y++) {
    for (let x = 0; x < want[y].length; x++) {
      const a = want[y][x]
      const b = got?.[y]?.[x]
      // A missing cell means the capture changed shape, a mismatch in itself.
      const delta = b
        ? Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
        : 255
      if (delta > TOLERANCE) past++
      if (!worst || delta > worst.delta) worst = { delta, x, y, want: a, got: b ?? null }
    }
  }
  return { past, worst }
}

/**
 * Decodes a screenshot inside the page and reduces it to a GRID x GRID grid of
 * average cell colour. Node has no image decoder here and this script carries no
 * dependencies, so the drawImage does the downscaling and averaging for us.
 */
const DECODE_GRID = (base64) => `(async () => {
  const img = new Image();
  img.src = 'data:image/png;base64,${base64}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = ${GRID};
  c.height = ${GRID};
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, ${GRID}, ${GRID});
  const px = ctx.getImageData(0, 0, ${GRID}, ${GRID}).data;
  const rows = [];
  for (let y = 0; y < ${GRID}; y++) {
    const row = [];
    for (let x = 0; x < ${GRID}; x++) {
      const i = (y * ${GRID} + x) * 4;
      row.push([px[i], px[i + 1], px[i + 2]]);
    }
    rows.push(row);
  }
  return rows;
})()`

/* ── chrome ─────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...CHROME_NAMES.map((n) => `/usr/bin/${n}`),
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  // CI images put it on PATH under a name we didn't guess (and snap-installed
  // chromium resolves to a stub path, so resolving from PATH is more reliable).
  const probe = process.platform === 'win32' ? 'where' : 'which'
  for (const name of CHROME_NAMES) {
    const hit = spawnSync(probe, [name], { encoding: 'utf8' })
    const resolved = hit.status === 0 ? hit.stdout.trim().split(/\r?\n/)[0] : ''
    if (resolved && existsSync(resolved)) return resolved
  }
  throw new Error('Chrome not found — set CHROME_PATH to the browser binary.')
}

async function responds(url, timeoutMs = 1500) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/** SIGTERM leaves grandchildren (esbuild, renderers) behind on Windows. */
async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      t.on('exit', resolve)
      t.on('error', resolve)
    })
  } else {
    child.kill('SIGKILL')
  }
  await sleep(200)
}

/* ── fixtures ───────────────────────────────────────────────────────── */

/** A valid WAV so the file input produces a real track (and a player box). */
function wav(seconds, freq) {
  const sampleRate = 8000
  const n = Math.floor(seconds * sampleRate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/* ── in-page measurement ────────────────────────────────────────────── */

const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = {
    vw, vh,
    media: {
      coarse: matchMedia('(pointer: coarse)').matches,
      drawerBreakpoint: matchMedia('(max-width: 860px)').matches,
    },
    scroll: { width: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth },
    escaping: [], spill: [], clipped: [], smallTargets: [], tinyTargets: [], offscreen: [],
    regions: {}, boundaries: [],
    drawer: null,
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = el.className && typeof el.className === 'string'
      ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return cls ? s + '.' + cls : s;
  };
  // The panel is an overlay drawer below the breakpoint: off-canvas is correct
  // there, so anything inside it is excluded from the off-screen checks.
  const inCollapsedDrawer = (el) => !!el.closest('.control-panel.collapsed');
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('canvas') || el.tagName === 'CANVAS') continue;
    if (!shown(el) || inCollapsedDrawer(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    if ((r.right > vw + 1 || r.left < -1) && cs.position !== 'fixed') {
      const parent = el.parentElement?.getBoundingClientRect();
      const parentAlsoOut = parent && (parent.right > vw + 1 || parent.left < -1);
      if (!parentAlsoOut) {
        out.escaping.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right) });
      }
    }
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible') {
      out.clipped.push({ el: name(el), text: (el.textContent || '').trim().slice(0, 24) });
    }
    const interactive = el.matches('button, [role=button], a[href], input, select, .dropdown-item, .menu-item, .xp-btn');
    if (interactive && cs.pointerEvents !== 'none') {
      const target = { el: name(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 18) };
      if (r.height < ${MIN_TARGET} || r.width < ${MIN_TARGET}) out.tinyTargets.push(target);
      else if (r.height < ${COMFORT_TARGET} || r.width < ${COMFORT_TARGET}) out.smallTargets.push(target);
    }
  }

  // Children escaping their own container (squeezed flex rows).
  for (const sel of ['.menu-bar', '.title-bar', '.apb-controls', '.apb-transport', '.apb-volume', '.apb-row', '.panel-footer', '.ctrl-row', '.spotify-auth-bar', '.status-bar']) {
    const box = document.querySelector(sel);
    if (!box || inCollapsedDrawer(box) || !shown(box)) continue;
    const boxRect = box.getBoundingClientRect();
    const parts = [...box.children].filter((c) => shown(c)).flatMap((child) => {
      const r = child.getBoundingClientRect();
      const overflows = r.right > boxRect.right + 1 || r.left < boxRect.left - 1;
      return overflows ? [{ el: name(child), right: Math.round(r.right), limit: Math.round(boxRect.right) }] : [];
    });
    if (parts.length) out.spill.push({ container: sel, parts: parts.slice(0, 4) });
  }

  for (const sel of ['.window-chrome', '.menu-bar', '.main-content', '.canvas-wrap', '.control-panel:not(.collapsed)', '.control-panel-scroll', '.panel-footer', '.audio-player-box', '.apb-transport', '.apb-track', '.status-bar', '.fullscreen-pill', '.canvas-loading']) {
    const el = document.querySelector(sel);
    if (!el) { out.regions[sel] = null; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.regions[sel] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      bottom: Math.round(r.bottom), display: cs.display,
    };
    if (shown(el) && (r.bottom > vh + 1 || r.top < -1 || r.right > vw + 1)) {
      out.offscreen.push({ sel, top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) });
    }
  }

  for (const sel of ['.app-error-fallback', '.scene-error-fallback']) {
    const el = document.querySelector(sel);
    if (el) out.boundaries.push({ sel, text: el.textContent.trim() });
  }

  const handle = document.querySelector('.panel-toggle-btn');
  if (handle && shown(handle)) {
    const r = handle.getBoundingClientRect();
    const panel = document.querySelector('.control-panel');
    out.drawer = {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      openBefore: panel ? !panel.classList.contains('collapsed') : null,
    };
  }
  return out;
})()`

/**
 * What a single preset's frame has to show for the sweep to pass. Read after the
 * page settles, and polled while it does.
 */
const PRESET_STATE = `(() => {
  const canvas = document.querySelector('.canvas-wrap canvas');
  // Only touch getContext once the Scene chunk has resolved: before that the
  // renderer does not exist yet, and asking for a context first would create one
  // with none of the attributes three asks for, out from under three.
  const ready = !!canvas && !document.querySelector('.canvas-loading');
  let gl = null, renderer = null, lost = null;
  if (ready) {
    // three asks for webgl2, and getContext() with a different type returns
    // null rather than the existing context — so probe in the same order.
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      lost = gl.isContextLost();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.VERSION);
    }
  }
  return {
    mounted: !!canvas,
    canvas: canvas ? canvas.width + 'x' + canvas.height : null,
    gl: !!gl,
    renderer,
    lost,
    loading: !!document.querySelector('.canvas-loading'),
    boundaries: [...document.querySelectorAll('.app-error-fallback, .scene-error-fallback')].map((el) => ({
      sel: el.className.trim().split(' ')[0],
      text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160),
    })),
  };
})()`

/**
 * Which preset the app actually switched to. The status bar would say so
 * directly, but its `Preset:` tag only exists while the status bar is toggled
 * on; the Presets menu always marks the current id with `.checked`, and its
 * items are rendered in src/presets.ts order — so the checked item's index is
 * the id. Without this the sweep could render mellow2 thirteen times and pass.
 */
const TOGGLE_PRESETS_MENU = `[...document.querySelectorAll('.menu-item')]
  .find((el) => el.textContent.trim() === 'Presets')?.click()`

const READ_CHECKED_PRESET = `(() => {
  const items = [...document.querySelectorAll('.menu-dropdown .dropdown-item')];
  return { items: items.length, index: items.findIndex((el) => el.classList.contains('checked')) };
})()`

/* ── report shaping ─────────────────────────────────────────────────── */

function analyse(sample, { pointer, width }) {
  const findings = []
  const add = (level, message) => findings.push({ level, message })

  if (sample.scroll.width > sample.scroll.client + 1) {
    add('failure', `page scrolls horizontally (${sample.scroll.width} > ${sample.scroll.client})`)
  }
  for (const item of sample.escaping) {
    add('failure', `${item.el} escapes the viewport (left ${item.left}, right ${item.right})`)
  }
  for (const item of sample.spill) {
    add('failure', `${item.parts.length} child element(s) spill out of ${item.container}`)
  }
  for (const item of sample.offscreen) {
    add('failure', `${item.sel} is off-screen (top ${item.top}, right ${item.right}, bottom ${item.bottom})`)
  }
  for (const item of sample.tinyTargets) {
    add('failure', `${item.el} is a ${item.w}x${item.h} target ("${item.text}"), under ${MIN_TARGET}px`)
  }
  for (const item of sample.boundaries) {
    add('failure', `${item.sel} rendered: ${item.text}`)
  }
  for (const item of sample.clipped) {
    add('info', `${item.el} clips its text ("${item.text}")`)
  }
  // Touch comfort only matters where a finger is the input.
  if (pointer === 'touch') {
    for (const item of sample.smallTargets) {
      add('info', `${item.el} is ${item.w}x${item.h} ("${item.text}"), under the comfortable ${COMFORT_TARGET}px`)
    }
  }
  // Narrow viewports are a drawer: the handle must exist and the panel must
  // start closed, otherwise the visualizer is hidden behind its own settings.
  if (width <= 860 && sample.drawer === null) {
    add('failure', 'no panel drawer handle below the 860px breakpoint')
  }
  if (width > 860 && sample.drawer !== null) {
    add('info', 'panel drawer handle is visible on a wide viewport')
  }
  return findings
}

/** Console arguments arrive as RemoteObjects; keep whatever text they carry. */
function consoleText(args = []) {
  const text = args
    .map((a) => a.value ?? a.unserializableValue ?? a.description ?? a.type ?? '')
    .join(' ')
  return text.replace(/\s+/g, ' ').trim().slice(0, 600)
}

/** `exceptionDetails.exception.description` carries the message plus stack. */
function exceptionText(details) {
  const text = details?.exception?.description ?? details?.text ?? 'uncaught exception'
  return text.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600)
}

// Resource loads depend on the network the probe happens to sit on — the Google
// fonts come from a CDN, and a blocked one is not app breakage. Everything else
// that reaches the console as an error is, including the case this sweep exists
// for: a GLSL compile failure, which three logs and then keeps drawing a black
// frame for.
const ENV_NOISE = /failed to load resource|net::err|err_blocked|fonts\.(googleapis|gstatic)\.com/i

const errorLevel = (entry) => (ENV_NOISE.test(entry.text) ? 'info' : 'failure')

function analysePreset(preset, state, errors, menu, presetIds) {
  const findings = []
  const add = (level, message) => findings.push({ level, message })

  for (const item of state.boundaries) add('failure', `${item.sel} rendered: ${item.text}`)
  if (!state.mounted) add('failure', 'no canvas in .canvas-wrap — the scene never mounted')
  else if (state.loading) add('failure', '.canvas-loading never cleared — the Scene chunk did not resolve')
  else if (!state.gl) add('failure', 'the canvas has no WebGL context')
  if (state.lost) add('failure', 'the WebGL context is lost')
  // Without this there is no way to tell a broken preset apart from the sweep
  // repeatedly rendering the same one.
  const applied = menu.index >= 0 ? presetIds[menu.index] : undefined
  if (applied === undefined) {
    add(
      'info',
      `could not confirm the applied preset (Presets menu listed ${menu.items} item(s), none of them checked)`,
    )
  } else if (applied !== preset) {
    add('failure', `#p= did not apply: the Presets menu marks "${applied}", expected "${preset}"`)
  }
  for (const entry of errors) add(errorLevel(entry), `${entry.source}: ${entry.text}`)
  return findings
}

/**
 * The frame half of the sweep. Separate from analysePreset because it is the
 * only part that reads a committed file, so it reports back whether the
 * comparison actually happened.
 */
function analyseFrame(preset, first, second, baseline) {
  const findings = []
  const add = (level, message) => findings.push({ level, message })
  // No capture means no canvas, which the mount checks above already reported.
  if (!first) return { findings, compared: false }

  // Two captures of a frozen frame have to agree, otherwise there is nothing
  // stable to compare a reference against and a passing run would mean nothing.
  const drift = compareFrames(first, second)
  if (drift.past) {
    add(
      'info',
      `the frame moved between two captures (${drift.past} cells past ${TOLERANCE}) — the frozen clock is not holding`,
    )
  }

  if (!baseline) {
    add('failure', `no reference frame at ${baselineLabel(preset)} — run with --update-baselines and commit it`)
    return { findings, compared: false }
  }
  if (baseline.grid !== GRID || baseline.size !== SWEEP.size[0]) {
    add(
      'info',
      `reference frame is ${baseline.grid}x${baseline.grid} at ${baseline.size}, this sweep captures ${GRID}x${GRID} at ${SWEEP.size[0]} — not comparing`,
    )
    return { findings, compared: false }
  }

  // amPreset, am2Preset, waveform and chromaticBurst draw nothing at all without
  // audio — checked unfrozen too, so it is silence and not the frozen clock. A
  // black reference frame can only ever report "it started drawing something",
  // which is not a regression worth failing on. Say the gap out loud instead of
  // pretending the frame was checked.
  if (isBlank(baseline.rows)) {
    add(
      'info',
      `reference frame is uniformly black — this preset draws nothing without audio, so its look is not covered by the frame comparison`,
    )
    return { findings, compared: false }
  }

  const { past, worst } = compareFrames(baseline.rows, first)
  if (past > ALLOWED_CELLS) {
    const what = isBlank(first)
      ? `renders a black frame where ${baselineLabel(preset)} does not`
      : `renders differently from ${baselineLabel(preset)}`
    add(
      'failure',
      `${what}: ${past} of ${GRID * GRID} cells past tolerance ${TOLERANCE} (${ALLOWED_CELLS} allowed; worst ${worst.delta} at ${worst.x},${worst.y}: rgb(${worst.got}) rendered, rgb(${worst.want}) expected). If the new look is intended, run --update-baselines.`,
    )
  }
  return { findings, compared: true }
}

/* ── run ────────────────────────────────────────────────────────────── */

const startedServer = !(await responds(URL))
const serverLabel = startedServer ? `${SERVER} :${PORT} (started here)` : `${URL} (already running)`
let vite = null
let chrome = null
let ws = null
let profile = null
let fixtureDir = null
let chromePath = ''

try {
  if (startedServer) {
    const mode = SERVER === 'preview' ? ['preview'] : []
    vite = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', ...mode, '--port', String(PORT), '--strictPort'],
      { cwd: process.cwd(), stdio: 'ignore' },
    )
    const end = Date.now() + 60000
    while (Date.now() < end && !(await responds(URL, 1000))) await sleep(400)
    if (!(await responds(URL))) throw new Error(`vite did not serve ${URL}`)
  }

  if (LOAD_AUDIO) {
    fixtureDir = mkdtempSync(join(tmpdir(), 'viz-fixtures-'))
    writeFileSync(join(fixtureDir, 'probe-one.wav'), wav(20, 220))
    writeFileSync(join(fixtureDir, 'probe-two.wav'), wav(20, 660))
  }

  profile = mkdtempSync(join(tmpdir(), 'viz-chrome-'))
  chromePath = findChrome()
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--enable-unsafe-swiftshader', // WebGL without a GPU
      // SwiftShader on purpose, to render the way CI does and prove the
      // committed reference frames do not depend on this machine's GPU.
      ...(SOFTWARE_GL ? ['--use-angle=swiftshader'] : []),
      '--autoplay-policy=no-user-gesture-required',
      // Chrome refuses to sandbox as root, which is how containers usually run.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  {
    const end = Date.now() + 30000
    while (Date.now() < end && !(await responds(`http://127.0.0.1:${CDP_PORT}/json/version`))) await sleep(300)
  }

  const target = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let seq = 0
  const pending = new Map()
  const events = []
  // Errors seen since the last navigation. Only the preset sweep collects them:
  // that is the only place a GLSL failure is visible (see the header comment).
  let pageErrors = []
  let captureErrors = false
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg.method)
      if (!captureErrors) return
      if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params.type === 'error' || msg.params.type === 'assert') {
          pageErrors.push({ source: `console.${msg.params.type}`, text: consoleText(msg.params.args) })
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push({ source: 'exception', text: exceptionText(msg.params.exceptionDetails) })
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const { source, text, url } = msg.params.entry
        // The Log domain mirrors console and uncaught errors as 'javascript',
        // duplicating what is captured above. Take only browser-level entries:
        // failed resource loads and CSP violations.
        // The url is worth appending: "400" without it says nothing about what
        // was requested.
        if (source !== 'javascript') {
          pageErrors.push({ source: `log/${source}`, text: url ? `${text} — ${url}` : text })
        }
      }
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** Runtime.evaluate reports page-side throws in the result, not as an error. */
  const evaluate = async (expression, options = {}) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...options,
    })
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page-side error: ${detail}`)
    }
    return result.result.value
  }

  await send('Page.enable')
  await send('DOM.enable')
  await send('Runtime.enable')
  await send('Log.enable')

  /**
   * Virtual animation clock, installed for the sweep only. It starts paused: the
   * app mounts at virtual time 0, the synthetic audio goes in, and only then does
   * the probe start stepping. That order matters — if the audio arrived part way
   * through, the analysis envelopes would be somewhere in a transition that
   * depends on how long the page took to mount.
   *
   * The clock stops itself at exactly CAPTURE_CLOCK_MS, so the captured frame is
   * a function of the code alone rather than of how long anything took. The
   * layout runs above stay on the real clock: an entrance animation frozen
   * mid-flight would move the very things they measure.
   */
  const VIRTUAL_CLOCK = `
    (() => {
      window.__probeMs = 0;
      window.__probeStep = 0;
      window.__probeFrames = 0;
      performance.now = () => window.__probeMs;
      const tick = () => {
        if (window.__probeStep > 0) {
          window.__probeMs += window.__probeStep;
          window.__probeFrames++;
          if (window.__probeMs >= ${CAPTURE_CLOCK_MS}) {
            window.__probeMs = ${CAPTURE_CLOCK_MS};
            window.__probeStep = 0;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
  `

  const START_CLOCK = `(window.__probeStep = ${VIRTUAL_STEP_MS})`
  const CLOCK_STATE = `({
    ms: window.__probeMs,
    frames: window.__probeFrames,
    running: window.__probeStep > 0,
  })`
  const AUDIO_PAYLOAD = `(window.postMessage({
    source: 'visualizer-audio-extension',
    type: 'audio-data',
    signal: ${SYNTHETIC_AUDIO.signal},
    bins: ${JSON.stringify(SYNTHETIC_AUDIO.bins)},
    wave: ${JSON.stringify(SYNTHETIC_AUDIO.wave)},
  }, '*'), true)`

  /** The canvas rect in CSS px, for the screenshot clip. */
  const canvasBox = async () => {
    const box = await evaluate(`(() => {
      const canvas = document.querySelector('.canvas-wrap canvas');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`)
    return box && box.width >= GRID && box.height >= GRID ? box : null
  }

  /**
   * The visible canvas as a GRID grid of average cell colour, at a fixed
   * animation time. Deliberately the composited screenshot rather than a
   * readPixels: R3F has no preserveDrawingBuffer, so the drawing buffer is gone
   * by the time anything can read it, and the composited frame is what a person
   * would actually see.
   */
  const captureFrame = async () => {
    // The clock is stopped by now, so this is just room for a frame to draw.
    await sleep(300)
    const box = await canvasBox()
    if (!box) return null
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      // A quarter scale keeps the payload small; the comparison is 16 cells
      // across either way, so nothing that survives averaging is lost.
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 0.25 },
    })
    return evaluate(DECODE_GRID(shot.data), { awaitPromise: true })
  }

  /**
   * Hand the app the synthetic audio, then run the virtual clock to the capture
   * frame. Returns the clock state, which says whether the run got there.
   */
  const simulate = async () => {
    await evaluate(AUDIO_PAYLOAD)
    await evaluate(START_CLOCK)
    let state = { ms: 0, frames: 0, running: true }
    // 60 frames of a full-screen shader is a second or two on a GPU and can be
    // twenty on SwiftShader, hence the generous ceiling.
    for (let i = 0; i < 150 && state.running; i++) {
      await sleep(100)
      state = await evaluate(CLOCK_STATE)
    }
    return state
  }

  const results = []
  for (const pointer of POINTERS) {
    for (const [label, width, height, dsf] of SIZES) {
      const touch = pointer === 'touch'
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: touch,
        ...(touch ? { maxTouchPoints: 5 } : {}),
      })
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: dsf,
        mobile: touch,
        screenOrientation:
          width > height
            ? { type: 'landscapePrimary', angle: 90 }
            : { type: 'portraitPrimary', angle: 0 },
      })
      // A clean profile per viewport, so a persisted preference written by the
      // previous size can't mask the first-load defaults.
      await send('Runtime.evaluate', {
        expression: 'try { localStorage.clear(); sessionStorage.clear() } catch (e) {}',
      })
      events.length = 0
      await send('Page.navigate', { url: URL })
      for (let i = 0; i < 80 && !events.includes('Page.loadEventFired'); i++) await sleep(250)
      await sleep(2200)

      if (LOAD_AUDIO) {
        const doc = await send('DOM.getDocument', { depth: 1 })
        const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' })
        if (input.nodeId) {
          await send('DOM.setFileInputFiles', {
            files: [
              join(fixtureDir, 'probe-one.wav'),
              join(fixtureDir, 'probe-two.wav'),
            ],
            nodeId: input.nodeId,
          })
          await sleep(1500)
        }
      }

      const sample = await evaluate(MEASURE)

      // Prove the drawer handle is usable, not just present.
      let drawerTap = null
      if (sample.drawer) {
        const { x, y } = sample.drawer
        if (touch) {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } else {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        }
        await sleep(700)
        const after = await evaluate(
          `(() => { const p = document.querySelector('.control-panel'); return { collapsed: p.classList.contains('collapsed'), width: Math.round(p.getBoundingClientRect().width), x: Math.round(p.getBoundingClientRect().x) }; })()`,
        )
        drawerTap = { before: sample.drawer.openBefore, after }
      }

      const findings = analyse(sample, { pointer, width })
      if (drawerTap && drawerTap.after.collapsed) {
        findings.push({
          level: 'failure',
          message: `tapping the drawer handle did not open the panel (still collapsed at x${drawerTap.after.x})`,
        })
      }
      results.push({ pointer, size: label, width, height, sample, findings })
    }
  }

  /* ── preset sweep ────────────────────────────────────────────────── */

  const presetRuns = []
  if (PRESETS.length) {
    const [sweepSize, width, height, dsf] = SWEEP.size
    const sweepPointer = SWEEP.pointer
    const touch = sweepPointer === 'touch'
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: touch,
      ...(touch ? { maxTouchPoints: 5 } : {}),
    })
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dsf,
      mobile: touch,
      screenOrientation:
        width > height
          ? { type: 'landscapePrimary', angle: 90 }
          : { type: 'portraitPrimary', angle: 0 },
    })
    // The layout runs above stay on the real clock on purpose: an entrance
    // animation frozen mid-flight would move the very things they measure.
    const clockScript = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: VIRTUAL_CLOCK,
    })

    for (const preset of PRESETS) {
      await send('Runtime.evaluate', {
        expression: 'try { localStorage.clear(); sessionStorage.clear() } catch (e) {}',
      })
      // The app reads #p= once on mount, so changing only the hash would be a
      // same-document navigation that leaves the previous preset on screen (and
      // never fires loadEventFired). The query makes each one a fresh load.
      const encoded = Buffer.from(JSON.stringify({ presetType: preset })).toString('base64')
      pageErrors = []
      captureErrors = true
      events.length = 0
      await send('Page.navigate', {
        url: `${URL}?viz-probe-preset=${encodeURIComponent(preset)}#p=${encoded}`,
      })
      for (let i = 0; i < 80 && !events.includes('Page.loadEventFired'); i++) await sleep(250)

      // Wait for the lazy Scene chunk rather than sleeping a flat amount: the
      // shaders compile on the first drawn frame, and a compile failure only
      // reaches the console once that has happened.
      let state = await evaluate(PRESET_STATE)
      for (let i = 0; i < 40 && !(state.mounted && !state.loading); i++) {
        await sleep(250)
        state = await evaluate(PRESET_STATE)
      }
      await sleep(1200)
      state = await evaluate(PRESET_STATE)

      // Synthetic audio in, then the virtual clock stepped to the capture frame:
      // nothing visual is measured until the app has had a full, fixed run of
      // simulated time with the signal present.
      const clock = await simulate()

      await evaluate(TOGGLE_PRESETS_MENU)
      await sleep(150)
      const menu = await evaluate(READ_CHECKED_PRESET)
      await evaluate(TOGGLE_PRESETS_MENU)

      // Two captures: the second is not compared against anything, it is there
      // to show the first is stable enough to be worth comparing.
      const first = await captureFrame()
      const second = await captureFrame()
      captureErrors = false

      const findings = analysePreset(preset, state, pageErrors, menu, PRESET_IDS)
      if (clock.running) {
        findings.push({
          level: 'info',
          message: `the virtual clock did not reach the capture frame (${clock.ms}ms after ${clock.frames} frames) — the frame is not settled`,
        })
      }
      // A renderer-sensitive preset has no reference to hold it to (see
      // RENDERER_SENSITIVE). Say so on every run, in both modes, rather than
      // quietly counting it as covered.
      let compared = false
      let written = false
      if (RENDERER_SENSITIVE.has(preset)) {
        findings.push({
          level: 'info',
          message:
            'not compared — its frame is not renderer-independent (see RENDERER_SENSITIVE in this script)',
        })
      } else if (UPDATE_BASELINES) {
        if (first) {
          writeBaseline(preset, first, state.renderer)
          written = true
          findings.push({ level: 'info', message: `wrote ${baselineLabel(preset)}` })
        }
      } else {
        const frame = analyseFrame(preset, first, second, readBaseline(preset))
        findings.push(...frame.findings)
        compared = frame.compared
      }

      presetRuns.push({
        preset,
        pointer: sweepPointer,
        size: sweepSize,
        state,
        clock,
        menu,
        errors: pageErrors,
        // The capture itself, so a --json report says what was actually seen
        // rather than only whether it matched.
        frame: first,
        compared,
        written,
        findings,
      })
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: clockScript.identifier,
    })
  }

  /* ── output ──────────────────────────────────────────────────────── */

  const runFindings = [...results, ...presetRuns].flatMap((r) => r.findings)
  const failures = runFindings.filter((f) => f.level === 'failure').length
  const infos = runFindings.filter((f) => f.level === 'info').length

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { url: URL, server: serverLabel, chrome: chromePath, results, presets: presetRuns, failures, infos },
        null,
        2,
      ),
    )
  } else {
    console.log(`\nviewport probe — ${URL}`)
    console.log(`server: ${serverLabel}`)
    console.log(`chrome: ${chromePath}`)
    console.log(
      `${results.length} viewport runs, ${presetRuns.length} preset runs, ${failures} failure(s), ${infos} info`,
    )
    for (const result of results) {
      const failed = result.findings.filter((f) => f.level === 'failure')
      const noted = result.findings.filter((f) => f.level === 'info')
      const status = failed.length ? 'FAIL' : noted.length ? 'note' : ' ok '
      console.log(`\n[${status}] ${result.pointer} ${result.size}`)
      for (const f of failed) console.log(`   ✗ ${f.message}`)
      for (const f of noted) console.log(`   · ${f.message}`)
      const r = result.sample.regions
      const brief = (sel) => {
        const v = r[sel]
        return !v || v.display === 'none' ? `${sel}: hidden` : `${sel}: ${v.w}x${v.h} @${v.x}`
      }
      if (!failed.length) {
        console.log(
          `   ${brief('.control-panel:not(.collapsed)')} | ${brief('.canvas-wrap')} | ${brief('.audio-player-box')}`,
        )
      }
      if (result.sample.drawer) {
        const tap = result.findings.find((f) => f.message.startsWith('tapping'))
        console.log(
          `   panel handle ${result.sample.drawer.w}x${result.sample.drawer.h}, tap ${tap ? 'failed' : `→ ${result.sample.drawer.openBefore ? 'closed' : 'opened'}`}`,
        )
      }
    }
    if (presetRuns.length) {
      const renderer = presetRuns.find((r) => r.state.renderer)?.state.renderer
      console.log(
        `\npreset sweep — ${presetRuns.length} preset(s) at ${presetRuns[0].size} / ${presetRuns[0].pointer}`,
      )
      if (renderer) console.log(`gl: ${renderer}`)
      const written = presetRuns.filter((r) => r.written).length
      const compared = presetRuns.filter((r) => r.compared).length
      console.log(
        written
          ? `frames: ${written} reference frame(s) written to ${BASELINE_DIR}/`
          : `frames: ${compared} of ${presetRuns.length} compared against ${BASELINE_DIR}/`,
      )
      for (const run of presetRuns) {
        const failed = run.findings.filter((f) => f.level === 'failure')
        const noted = run.findings.filter((f) => f.level === 'info')
        const status = failed.length ? 'FAIL' : noted.length ? 'note' : ' ok '
        console.log(`[${status}] ${run.preset}`)
        for (const f of failed) console.log(`   ✗ ${f.message}`)
        for (const f of noted) console.log(`   · ${f.message}`)
      }
    }
    console.log(
      failures
        ? '\nFailures above are real breakage (viewport escape, spill, off-screen regions, targets under 24px, unreachable drawer) or a preset that did not render cleanly.\n'
        : '\nNo failures.\n',
    )
  }

  // Plain output gates on findings (handy locally); JSON only gates with --fail
  // so a report can be piped into other tooling without failing the command.
  const gates = JSON_OUT ? has('fail') : true
  process.exitCode = gates && (failures > 0 || (STRICT && infos > 0)) ? 1 : 0
} catch (err) {
  console.error('viewport probe failed:', err instanceof Error ? err.message : err)
  process.exitCode = 2
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  await killTree(chrome)
  await killTree(vite)
  for (const dir of [profile, fixtureDir]) {
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Chrome may still hold a lock; the OS cleans its temp dir eventually */
    }
  }
}
