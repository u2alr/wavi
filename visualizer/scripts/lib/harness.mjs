/**
 * Shared plumbing for the headless browser checks in scripts/.
 *
 * check-csp.mjs and the preset smoke pass need the same three things: dist/
 * served the way Cloudflare Pages serves it, a Chrome driven over the DevTools
 * protocol, and a way to tell app breakage apart from a resource that merely did
 * not load on this network. Every one of those has a non-obvious detail recorded
 * at the point it matters, and keeping them in one file is what stops the two
 * checks from drifting into two different ideas of what "a clean load" means.
 *
 * Not a dependency and not a framework: plain Node plus whichever Chrome is
 * installed. Set CHROME_PATH if findChrome() cannot find it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

export const DIST_DIR = 'dist'
export const PAGES_HEADER_FILE = 'public/_headers'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── classifying what the console reported ──────────────────────────── */

/** Console arguments arrive as RemoteObjects; keep whatever text they carry. */
export function consoleText(args = []) {
  const text = args
    .map((a) => a.value ?? a.unserializableValue ?? a.description ?? a.type ?? '')
    .join(' ')
  // Chrome's shader logs carry NUL bytes between fields, and those would land in
  // a report as invisible filler around the part worth reading. Written as a
  // literal replacement rather than as a character class, which lint rightly
  // objects to.
  return text.replaceAll('\0', ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
}

/** `exceptionDetails.exception.description` carries the message plus stack. */
export function exceptionText(details) {
  const text = details?.exception?.description ?? details?.text ?? 'uncaught exception'
  return text.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600)
}

// Resource loads depend on the network the check happens to sit on — the Google
// fonts come from a CDN, and a blocked one is not app breakage.
export const ENV_NOISE = /failed to load resource|net::err|err_blocked|fonts\.(googleapis|gstatic)\.com/i

// A CSP refusal is tested before ENV_NOISE, and the order is the whole point: the
// refusal for the Google font stylesheet reads "Loading the stylesheet
// 'https://fonts.googleapis.com/css2?...' violates the following Content Security
// Policy directive: ...", so the noise pattern above would match it and file the
// exact thing the policy check exists to catch as environmental — silently.
export const CSP_VIOLATION = /violates the following|content security policy/i
export const isCspViolation = (entry) => CSP_VIOLATION.test(entry.text)

/* ── the header file ────────────────────────────────────────────────── */

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * The subset of the _headers syntax this repo uses: a path pattern line followed
 * by indented `Name: value` lines (or `! Name` to detach one).
 *
 * Anything outside that subset throws instead of quietly matching nothing. A
 * pattern this parser cannot evaluate would apply no headers, and a response
 * with no policy cannot violate one — so an unparsed rule would read as "clean"
 * rather than as a broken check.
 */
export function readHeaderRules(file = PAGES_HEADER_FILE) {
  const path = join(process.cwd(), file)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${file} — it is what this check serves`)
  }
  const rules = []
  let current = null
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    if (/^\s/.test(raw)) {
      const detach = line.startsWith('!')
      const body = detach ? line.slice(1).trim() : line
      const at = body.indexOf(':')
      if (!current) throw new Error(`${file}:${index + 1}: header line before any path rule`)
      if (at === -1) throw new Error(`${file}:${index + 1}: not a "Name: value" header`)
      current.headers.push([
        body.slice(0, at).trim().toLowerCase(),
        detach ? null : body.slice(at + 1).trim(),
      ])
      return
    }
    if (line.includes(':')) {
      throw new Error(
        `${file}:${index + 1}: pattern "${line}" uses a host or placeholder, which this matcher does not implement`,
      )
    }
    current = { pattern: line, headers: [] }
    rules.push(current)
  })
  return rules
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every header that applies to a request path. Matched against the request, not
 * against the file that ends up serving it: Pages applies _headers rules to the
 * incoming path, so the SPA fallback response for /callback is covered by a /*
 * rule. A header set twice is joined with a comma, which is what Pages does.
 */
export function headersForPath(rules, pathname) {
  const out = new Map()
  for (const rule of rules) {
    const re = new RegExp(`^${rule.pattern.split('*').map(escapeRe).join('.*')}$`)
    if (!re.test(pathname)) continue
    for (const [name, value] of rule.headers) {
      if (value === null) out.delete(name)
      else out.set(name, out.has(name) ? `${out.get(name)}, ${value}` : value)
    }
  }
  return out
}

/** The header rules that apply to a path, as the file declares them. */
export const declaredHeaders = (pathname, file = PAGES_HEADER_FILE) =>
  headersForPath(readHeaderRules(file), pathname)

/* ── serving dist/ the way the host does ────────────────────────────── */

/**
 * dist/ plus, when `headerFile` is given, the rules in public/_headers applied to
 * the incoming request path, and the SPA fallback Pages applies when the build
 * has no 404.html.
 *
 * The header file is optional because only the policy check is about headers:
 * passing the path there is the whole point of that check, and passing nothing
 * keeps a preset failure from being reported as (or masked by) a policy one.
 */
export function startDistServer({ port, distDir = DIST_DIR, headerFile = null }) {
  const root = resolve(process.cwd(), distDir)
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`${distDir}/index.html not found — run npm run build first`)
  }
  const rules = headerFile ? readHeaderRules(headerFile) : []
  const fallback = !existsSync(join(root, '404.html'))

  const server = createServer((req, res) => {
    try {
      // Split by hand rather than with `new URL` to keep the server free of the
      // URL constructor entirely; the paths served here are plain.
      const pathname = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]) || '/'
      let file = pathname === '/' ? join(root, 'index.html') : resolve(root, `.${pathname}`)
      const usable = file.startsWith(root) && existsSync(file) && statSync(file).isFile()
      if (!usable) {
        // Pages' default behaviour with no 404.html in the build: unmatched paths
        // render the root document with a 200. A 404.html disables it, so this
        // mirrors that rather than being more forgiving than the host.
        if (!fallback) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        file = join(root, 'index.html')
      }
      const headers = {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(statSync(file).size),
        ...Object.fromEntries(headersForPath(rules, pathname)),
      }
      res.writeHead(200, headers)
      res.end(readFileSync(file))
    } catch (err) {
      // A throw in here happens off the main flow, where it would kill the check
      // with a stack trace and no report. Answer instead: the page fails loudly
      // and the "did the app render" assertion says why.
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`static server error: ${err instanceof Error ? err.message : err}`)
    }
  })

  return new Promise((done, reject) => {
    server.once('error', (err) => {
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `port ${port} is already in use — this check serves ${distDir}/ itself, so pass --port`
            : `static server failed: ${err.message}`,
        ),
      )
    })
    server.listen(port, '127.0.0.1', () => done(server))
  })
}

/* ── chrome ─────────────────────────────────────────────────────────── */

const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

export function findChrome() {
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

export async function responds(url, timeoutMs = 1500) {
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

/** SIGTERM leaves grandchildren (renderers) behind on Windows. */
export async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      t.on('exit', done)
      t.on('error', done)
    })
  } else {
    child.kill('SIGKILL')
  }
  await sleep(200)
}

/**
 * Chrome, headless, with WebGL. `--enable-unsafe-swiftshader` is what lets the
 * scene mount on a machine with no GPU, which is what CI is; callers can add
 * `--use-angle=swiftshader` to render through the software rasteriser even where
 * a GPU exists, which is how CI's renderer is reproduced locally.
 */
export async function launchChrome({ port, extraArgs = [] }) {
  const path = findChrome()
  // A throwaway profile, so a check never reads a preference a previous run or a
  // real browsing session wrote.
  const profile = mkdtempSync(join(tmpdir(), 'viz-chrome-'))
  const chrome = spawn(
    path,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--enable-unsafe-swiftshader', // WebGL without a GPU, so the scene mounts
      // Chrome refuses to sandbox as root, which is how containers usually run.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      '--window-size=1280,900',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const end = Date.now() + 30000
  while (Date.now() < end && !(await responds(`http://127.0.0.1:${port}/json/version`))) {
    await sleep(300)
  }
  if (!(await responds(`http://127.0.0.1:${port}/json/version`))) {
    await killTree(chrome)
    removeProfile(profile)
    throw new Error(
      `Chrome opened no debugging port on ${port} within 30s — is CHROME_PATH the real binary?`,
    )
  }
  return { chrome, path, profile }
}

/**
 * Best effort: Chrome can still hold handles in its profile for a moment after
 * it is killed, and on Windows that turns a passing run into an EPERM stack
 * trace. A leftover directory in the temp folder is not worth failing over, so
 * the wait and the retries are there to make the note rare, and the note is
 * there so a run that could not clean up still says so.
 */
export async function removeProfile(profile, note = () => {}) {
  if (!profile) return
  await sleep(400)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch {
    note(`could not remove the temporary Chrome profile at ${profile} — safe to delete by hand`)
  }
}

/**
 * A DevTools-protocol client for one page, plus the error collection the checks
 * report from.
 *
 * What it collects, and why: `entries` fills with anything that reached the
 * console as an error, with uncaught exceptions, and with the browser-level
 * entries the Log domain adds — refusals and failed resource loads, at any
 * level. It deliberately does NOT take Log entries whose source is 'javascript',
 * because those mirror console and uncaught errors and would double every one of
 * them.
 *
 * Nothing is collected until `capturing` is set: a navigation's errors are only
 * interesting for the page that follows it, and a stale entry from the last
 * preset would otherwise be attributed to the next one.
 */
export async function connectCdp(port) {
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    ws.onopen = done
    ws.onerror = reject
  })

  let seq = 0
  const pending = new Map()

  const client = {
    /** Errors seen since `capturing` was turned on. */
    entries: [],
    /** Event method names, which is how a caller waits for Page.loadEventFired. */
    events: [],
    capturing: false,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => {
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    },
  }

  /** Runtime.evaluate reports page-side throws in the result, not as an error. */
  client.evaluate = async (expression, options = {}) => {
    const result = await client.send('Runtime.evaluate', {
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

  /** Drops what has been collected, for the next navigation. */
  client.reset = () => {
    client.entries.length = 0
    client.events.length = 0
  }

  /** Resolves once the page has fired its load event (or the ceiling passes). */
  client.waitForLoad = async (ticks = 80) => {
    for (let i = 0; i < ticks && !client.events.includes('Page.loadEventFired'); i++) {
      await sleep(250)
    }
  }

  client.enable = async () => {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Log.enable')
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (!msg.method) return
    client.events.push(msg.method)
    if (!client.capturing) return
    if (msg.method === 'Runtime.consoleAPICalled') {
      if (msg.params.type === 'error' || msg.params.type === 'assert') {
        client.entries.push({
          source: `console.${msg.params.type}`,
          text: consoleText(msg.params.args),
        })
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      client.entries.push({ source: 'exception', text: exceptionText(msg.params.exceptionDetails) })
    } else if (msg.method === 'Log.entryAdded') {
      const { level, source, text, url } = msg.params.entry
      // The url is worth appending: "400" without it says nothing about what was
      // requested.
      const entry = { source: `log/${source}`, text: url ? `${text} — ${url}` : text }
      // A refusal is taken at any level, not only 'error'. Measured: Chrome logs
      // them at 'error', so today the wider test catches nothing extra — it is
      // here so a check cannot go quietly blind if that level changes, or if a
      // report-only policy starts reporting at 'warning' instead. Catching a
      // refusal matters more than the exact level it arrives at.
      if (source !== 'javascript' && (level === 'error' || isCspViolation(entry))) {
        client.entries.push(entry)
      }
    }
  }

  return client
}
