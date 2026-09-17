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
 * that did not actually switch the preset. Compiling and mounting is of course
 * not the same as *looking* right — that still needs eyes.
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
 *
 * Exit code is 1 when a failure-level finding is present (0 with --json unless
 * --fail is passed), which is how CI gates on it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
                       Renders each preset at the first --sizes/--pointer
                       combination and fails on a shader, GL or console error.
                       The ids are read from src/presets.ts, so a new preset is
                       swept without editing this script.
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
// One viewport for the whole sweep: three compiles the same shaders at every
// size, and 13 ids x every size x every pointer would dominate the runtime.
const SWEEP = { pointer: POINTERS[0], size: SIZES[0] }

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
        const { source, text } = msg.params.entry
        // The Log domain mirrors console and uncaught errors as 'javascript',
        // duplicating what is captured above. Take only browser-level entries:
        // failed resource loads and CSP violations.
        if (source !== 'javascript') pageErrors.push({ source: `log/${source}`, text })
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
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true })
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
      await evaluate(TOGGLE_PRESETS_MENU)
      await sleep(150)
      const menu = await evaluate(READ_CHECKED_PRESET)
      await evaluate(TOGGLE_PRESETS_MENU)
      captureErrors = false

      presetRuns.push({
        preset,
        pointer: sweepPointer,
        size: sweepSize,
        state,
        menu,
        errors: pageErrors,
        findings: analysePreset(preset, state, pageErrors, menu, PRESET_IDS),
      })
    }
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
