#!/usr/bin/env node
/**
 * Preset smoke pass.
 *
 * Loads every preset id in src/presets.ts through its own #p= deep link in
 * headless Chrome and reports whether each one mounted cleanly: no error
 * boundary, a canvas with a live WebGL context, no console or GL error, and a
 * deep link that demonstrably switched the preset.
 *
 * Why this exists. three.js reports a GLSL compile or link failure with
 * console.error and carries on drawing a black frame — nothing throws, no error
 * boundary fires, and no typecheck, lint or unit test can see it. The failure
 * only appears on the device of whoever is looking at that preset.
 *
 * What "a GL error" means here, precisely, because the term is loose: a shader
 * that fails to compile or link, which reaches the console as an error from
 * three; an uncaught exception; a thrown error inside the render loop; or a lost
 * context, which is read from isContextLost() directly rather than inferred.
 *
 * What it deliberately does not do: no reference frames, no pixels. A preset that
 * compiles, mounts and draws the wrong thing — black, the wrong palette, frozen,
 * ignoring its sliders — passes here, and that is the trade. Catching a look
 * regression needs either a committed frame to compare against (which then needs
 * regenerating on every intended look change) or eyes.
 *
 * Anti-vacuity: the mount check says a canvas exists, not that it is the canvas
 * for the preset in the URL. So each run is confirmed against the Presets menu,
 * which marks the current id — without that, the sweep could render one preset
 * twelve times and pass. The sweep feeds each preset the same fixed synthetic
 * spectrum, posted the way the browser extension posts it, because four presets
 * (amPreset, am2Preset, waveform, chromaticBurst) draw nothing at all without a
 * signal and their shaders would go unexercised.
 *
 * No test-runner or browser-automation dependency — plain Node + Chrome.
 *
 *   npm run check:presets
 *   npm run -- check:presets --presets acidWash,brat
 *   npm run check:presets -- --software-gl     # render like CI does
 *
 * Exit code is 1 when a preset fails. Needs dist/ (npm run build) and Chrome
 * (set CHROME_PATH if it is not where findChrome() looks).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  connectCdp,
  DIST_DIR,
  ENV_NOISE,
  isCspViolation,
  killTree,
  launchChrome,
  removeProfile,
  sleep,
  startDistServer,
} from './lib/harness.mjs'

const CDP_PORT = 9334
const DEFAULT_PORT = 4182

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
Usage: npm run check:presets -- [options]

  --presets=<id,id>  Presets to smoke, in order (default: every id in
                     src/presets.ts). Values: "all", "none", or a comma list.
  --port=<number>    Port to serve dist/ on (default ${DEFAULT_PORT}).
  --software-gl      Render through SwiftShader, the way CI does.

Serves dist/, loads each preset's #p= deep link in Chrome and fails on a console
or GL error, a missing WebGL context, or a deep link that did not apply. Run
npm run build first. No reference frames: this checks that a preset mounts and
draws without error, never what it looks like.
`)
  process.exit(0)
}

const PORT = Number(flag('port', DEFAULT_PORT))
const SOFTWARE_GL = has('software-gl')
const PAGE_URL = `http://127.0.0.1:${PORT}/`

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
    throw new Error(`cannot read ${file} — it is where the swept list comes from`)
  }
  const block = source.match(/PRESET_TYPES[^=]*=\s*\[([\s\S]*?)\]/)
  const ids = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  if (!ids.length) throw new Error(`no preset ids in ${file}`)
  return ids
}

const PRESET_IDS = readPresetIds()
const PRESETS = (() => {
  const raw = flag('presets', 'all')
  if (raw === 'none' || raw === 'false') return []
  if (raw === 'all' || raw === 'true') return PRESET_IDS
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
})()

/* ── the synthetic signal ───────────────────────────────────────────── */

/**
 * What the sweep renders with, posted the way the browser extension posts it —
 * the app listens for exactly this shape (App.tsx, 'visualizer-audio-extension').
 * Deterministic by construction: a fixed formula, no randomness, no decoder, no
 * playback position, so no preset's error state depends on where a track happens
 * to be.
 *
 * A music-shaped spectrum, so the seven visual bands differ from each other
 * rather than all reading one number, and a two-component waveform so the AM and
 * waveform presets have a trace worth drawing. Reads back as bass 0.74, mid
 * 0.28, treble 0.08.
 */
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

/* ── in-page measurement ────────────────────────────────────────────── */

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
 * the id.
 */
const OPEN_PRESETS_MENU = `[...document.querySelectorAll('.menu-item')]
  .find((el) => el.textContent.trim() === 'Presets')?.click()`

const READ_CHECKED_PRESET = `(() => {
  const items = [...document.querySelectorAll('.menu-dropdown .dropdown-item')];
  return { items: items.length, index: items.findIndex((el) => el.classList.contains('checked')) };
})()`

const AUDIO_PAYLOAD = `(window.postMessage({
  source: 'visualizer-audio-extension',
  type: 'audio-data',
  signal: ${SYNTHETIC_AUDIO.signal},
  bins: ${JSON.stringify(SYNTHETIC_AUDIO.bins)},
  wave: ${JSON.stringify(SYNTHETIC_AUDIO.wave)},
}, '*'), true)`

/* ── what a run means ───────────────────────────────────────────────── */

/**
 * One preset's findings. `menu` is the anti-vacuity half: a mounted canvas is
 * also what a sweep stuck on the previous preset would show.
 */
function analyse(preset, state, errors, menu) {
  const findings = []
  const add = (level, message) => findings.push({ level, message })

  for (const item of state.boundaries) add('failure', `${item.sel} rendered: ${item.text}`)
  if (!state.mounted) add('failure', 'no canvas in .canvas-wrap — the scene never mounted')
  else if (state.loading) add('failure', '.canvas-loading never cleared — the Scene chunk did not resolve')
  else if (!state.gl) add('failure', 'the canvas has no WebGL context')
  if (state.lost) add('failure', 'the WebGL context is lost')

  const applied = menu.index >= 0 ? PRESET_IDS[menu.index] : undefined
  if (applied === undefined) {
    add(
      'info',
      `could not confirm the applied preset (the Presets menu listed ${menu.items} item(s), none of them checked)`,
    )
  } else if (applied !== preset) {
    add('failure', `the #p= deep link did not apply: the Presets menu marks "${applied}", expected "${preset}"`)
  }

  for (const entry of errors) {
    if (isCspViolation(entry)) add('failure', `${entry.source}: ${entry.text}`)
    else if (ENV_NOISE.test(entry.text)) add('info', `${entry.source}: ${entry.text}`)
    else add('failure', `${entry.source}: ${entry.text}`)
  }
  return findings
}

/* ── report ─────────────────────────────────────────────────────────── */

let failures = 0
const ok = (message) => console.log(`  ok    ${message}`)
const note = (message) => console.log(`  note  ${message}`)
const fail = (message) => {
  failures++
  console.log(`  FAIL  ${message}`)
}

/* ── run ────────────────────────────────────────────────────────────── */

let server = null
let chrome = null
let profile = null
let client = null
const runs = []

try {
  console.log('Preset smoke pass')
  console.log(`  presets  ${PRESETS.length} of ${PRESET_IDS.length} in src/presets.ts`)
  console.log(`  serving  ${PAGE_URL} (${DIST_DIR}/)`)

  server = await startDistServer({ port: PORT })
  const launched = await launchChrome({
    port: CDP_PORT,
    // Renders through the software rasteriser even where a GPU exists, which is
    // how the smoke sees what CI sees.
    extraArgs: SOFTWARE_GL ? ['--use-angle=swiftshader'] : [],
  })
  chrome = launched.chrome
  profile = launched.profile
  console.log(`  chrome   ${launched.path}`)

  client = await connectCdp(CDP_PORT)
  await client.enable()

  for (const preset of PRESETS) {
    // A persisted preference written by the previous preset must not be able to
    // mask this one's first-load state.
    await client.evaluate('try { localStorage.clear(); sessionStorage.clear() } catch (e) {}')
    // The app reads #p= once on mount, so changing only the hash would be a
    // same-document navigation that leaves the previous preset on screen (and
    // never fires loadEventFired). The query makes each one a fresh load.
    const encoded = Buffer.from(JSON.stringify({ presetType: preset })).toString('base64')
    client.reset()
    client.capturing = true
    await client.send('Page.navigate', {
      url: `${PAGE_URL}?preset-smoke=${encodeURIComponent(preset)}#p=${encoded}`,
    })
    await client.waitForLoad()

    // Wait for the lazy Scene chunk rather than sleeping a flat amount: the
    // shaders compile on the first drawn frame, and a compile failure only
    // reaches the console once that has happened.
    let state = await client.evaluate(PRESET_STATE)
    for (let i = 0; i < 40 && !(state.mounted && !state.loading); i++) {
      await sleep(250)
      state = await client.evaluate(PRESET_STATE)
    }
    await sleep(1200)

    // The signal goes in only after the preset is up, so a shader that is built
    // lazily on the first non-silent frame is still reached, and then a second
    // and a half of real frames is room for a compile failure to be reported.
    await client.evaluate(AUDIO_PAYLOAD)
    await sleep(1500)
    state = await client.evaluate(PRESET_STATE)

    await client.evaluate(OPEN_PRESETS_MENU)
    await sleep(150)
    const menu = await client.evaluate(READ_CHECKED_PRESET)
    await client.evaluate(OPEN_PRESETS_MENU)
    client.capturing = false

    const findings = analyse(preset, state, client.entries, menu)
    runs.push({ preset, state, menu, findings })
  }

  const confirmed = runs.filter((r) => r.menu.index >= 0).length
  const glRuns = runs.filter((r) => r.state.gl)
  const renderer = glRuns.find((r) => r.state.renderer)?.state.renderer
  if (runs.length) console.log(`  gl       ${renderer ?? 'none reported'}`)

  for (const run of runs) {
    const failed = run.findings.filter((f) => f.level === 'failure')
    const noted = run.findings.filter((f) => f.level === 'info')
    if (failed.length) fail(run.preset)
    else if (noted.length) note(run.preset)
    else ok(run.preset)
    for (const f of run.findings) {
      console.log(`          ${f.level === 'failure' ? '✗' : '·'} ${f.message}`)
    }
  }

  // The controls, stated separately from the per-preset lines so a run that is
  // green because it proved nothing is visible as such.
  if (runs.length) {
    if (!runs.some((r) => r.state.gl)) {
      note(
        'no WebGL context in any run — this browser gave no renderer at all, so nothing above says anything about the presets',
      )
    }
    if (!confirmed) {
      fail(
        'no deep link could be confirmed against the Presets menu, so the sweep cannot tell a broken preset from the same one rendered ' +
          `${runs.length} times — check the Presets menu markup this script reads`,
      )
    } else if (confirmed < runs.length) {
      note(`deep links confirmed for ${confirmed} of ${runs.length} preset(s)`)
    }
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  client?.close()
  await killTree(chrome)
  await removeProfile(profile, note)
  if (server) await new Promise((done) => server.close(done))
}

console.log(
  failures
    ? `\n${failures} preset smoke failure(s).`
    : `\nPreset smoke passed: ${runs.length} preset(s) mounted with no console or GL error.`,
)
process.exit(failures ? 1 : 0)
