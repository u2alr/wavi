#!/usr/bin/env node
/**
 * Content-Security-Policy check.
 *
 * Serves dist/ the way Cloudflare Pages does — the built files, the rules in
 * public/_headers applied to the incoming request path, and the SPA fallback
 * Pages applies when the build has no 404.html — then loads the app under that
 * policy in real Chrome and reports what the browser refused.
 *
 * Why this needs a script of its own: vite neither reads the header file nor
 * sends what is in it, so the policy that actually ships cannot be exercised by
 * the dev server, by `vite preview`, or by any unit test. That policy is what
 * stops injected script from reading the Spotify tokens in localStorage, and its
 * failure mode is quiet — a blocked font or cover art is a missing resource, not
 * an exception — so without this the shipped policy rests on a hand-run check
 * against production.
 *
 * Three assertions come out of one load, and the third is what makes the first
 * two worth anything:
 *
 *   1. the served policy is the policy that was written — the response for /
 *      carries exactly the Content-Security-Policy the file declares. Without
 *      this, "no violations" would be reported just as happily by a file with no
 *      policy at all, since a page with no policy can violate none.
 *   2. the load is clean — any refusal Chrome reports is a failure, naming the
 *      directive and the blocked URL. A refusal is classified before
 *      resource-load noise on purpose: the refusal for the Google font
 *      stylesheet contains fonts.googleapis.com, so the noise pattern would
 *      otherwise swallow the exact thing this check exists to catch.
 *   3. the detector works — a deliberately blocked image and fetch are injected,
 *      and at least one refusal has to come back, or the run fails saying the
 *      clean result above proves nothing. Both are refused before any DNS
 *      lookup, so this needs no network and cannot be confused with a host that
 *      merely fails to resolve.
 *
 * What it cannot prove: that the policy is *sufficient* for paths a run never
 * takes. Covers and the Web API need a Spotify login, and canvas playback needs
 * a real track. Those are recorded in the README's Security section instead of
 * being counted here.
 *
 *   npm run check:csp
 *   npm run check:csp -- --port 4181
 *
 * Exit code is 1 when the check fails. Needs dist/ (npm run build) and Chrome
 * (set CHROME_PATH if it is not where findChrome() looks).
 */
import {
  connectCdp,
  declaredHeaders,
  DIST_DIR,
  ENV_NOISE,
  isCspViolation,
  killTree,
  launchChrome,
  PAGES_HEADER_FILE,
  readHeaderRules,
  removeProfile,
  sleep,
  startDistServer,
} from './lib/harness.mjs'

const CDP_PORT = 9333
const DEFAULT_PORT = 4180

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

if (argv.includes('--help')) {
  console.log(`
Usage: npm run check:csp -- [options]

  --port=<number>  Port to serve dist/ on (default ${DEFAULT_PORT}).

Serves dist/ with the rules from ${PAGES_HEADER_FILE}, loads it in Chrome and
fails on any Content-Security-Policy refusal. Run npm run build first.
`)
  process.exit(0)
}

// Named PAGE_URL rather than URL: binding URL here would shadow the global
// constructor, and this file has no need to parse anything.
const PORT = Number(flag('port', DEFAULT_PORT))
const PAGE_URL = `http://127.0.0.1:${PORT}/`

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

try {
  const declaredCsp = declaredHeaders('/').get('content-security-policy')
  console.log('Content-Security-Policy check')
  console.log(`  file     ${PAGES_HEADER_FILE}`)
  console.log(`  serving  ${PAGE_URL} (${DIST_DIR}/, header rules applied)`)

  if (!declaredCsp) {
    // Distinguish "the file has no policy" from "the file's rules do not cover
    // /": both leave / ungoverned, but only one of them is a rule-pattern bug,
    // and "declares no policy" would send someone looking in the wrong place.
    const declaredAnywhere = readHeaderRules().some((rule) =>
      rule.headers.some(([name, value]) => name === 'content-security-policy' && value),
    )
    fail(
      declaredAnywhere
        ? `${PAGES_HEADER_FILE} declares a Content-Security-Policy, but no rule of it applies to / — check the path patterns`
        : `${PAGES_HEADER_FILE} declares no Content-Security-Policy — there is nothing to enforce, and a regression would be invisible`,
    )
  } else {
    console.log(`  policy   ${declaredCsp}`)
  }

  server = await startDistServer({ port: PORT, headerFile: PAGES_HEADER_FILE })

  // Anti-vacuity. Everything below is of the form "no violations seen", which a
  // file with no policy and a server that applied nothing would report just as
  // happily. Ask for the policy first, then ask the page.
  //
  // Both sides of this comparison come from one parse of one file, so it cannot
  // fail because of what the policy says — it is a canary for this script's own
  // plumbing, i.e. for the server having stopped applying what it read.
  const servedCsp = (await fetch(PAGE_URL)).headers.get('content-security-policy')
  if (declaredCsp) {
    if (servedCsp === declaredCsp) {
      ok('the policy served on / is the policy written in the file')
    } else {
      fail(
        `the policy served on / is not the one in ${PAGES_HEADER_FILE}: ${
          servedCsp ? `served "${servedCsp}"` : 'no Content-Security-Policy header at all'
        }`,
      )
    }
  }

  const launched = await launchChrome({ port: CDP_PORT })
  chrome = launched.chrome
  profile = launched.profile
  console.log(`  chrome   ${launched.path}`)

  client = await connectCdp(CDP_PORT)
  await client.enable()

  client.reset()
  client.capturing = true
  await client.send('Page.navigate', { url: PAGE_URL })
  await client.waitForLoad()
  // Poll for the app rather than sleeping a flat amount: CI renders on
  // SwiftShader and is slower than a laptop, and a slow first paint must not
  // read as "the app did not render".
  const APP_BOOTED = `(() => { const root = document.querySelector('#root'); return !!root && root.children.length > 0; })()`
  let booted = false
  for (let i = 0; i < 40 && !booted; i++) {
    booted = await client.evaluate(APP_BOOTED)
    if (!booted) await sleep(250)
  }
  // Then give the late arrivals time to land: the font stylesheet and the lazily
  // imported Scene chunk both come after the first render, and a refusal for
  // either is one of the things this check exists to catch.
  await sleep(1500)
  // "No violations" only says something if the app actually loaded: a 404, a
  // blank document or a blocked entry script would otherwise pass.
  if (!booted) {
    fail('the app rendered nothing — there was no page to check the policy against')
  } else {
    ok('the app rendered under the served policy')
  }

  const onLoad = client.entries.slice()
  const violations = onLoad.filter(isCspViolation)
  for (const entry of violations) fail(`${entry.source}: ${entry.text}`)
  // Anything else that reached the console as an error is app breakage; a failed
  // resource load is reported and not failed, since it says what the network
  // looked like here rather than whether the policy is right.
  for (const entry of onLoad) {
    if (isCspViolation(entry)) continue
    if (ENV_NOISE.test(entry.text)) note(`${entry.source}: ${entry.text}`)
    else fail(`${entry.source}: ${entry.text}`)
  }
  if (!violations.length) ok('no CSP refusal on load')

  // The positive control. Both requests are refused by the browser before any
  // DNS lookup, so this needs no network and cannot be confused with a host that
  // merely fails to resolve.
  client.entries.length = 0
  await client.evaluate(`(() => {
    const img = document.createElement('img');
    img.src = 'https://csp-control.invalid/pixel.png';
    document.body.appendChild(img);
    fetch('https://csp-control.invalid/control.json').catch(() => {});
    return true;
  })()`)
  let control = []
  for (let i = 0; i < 20 && !control.length; i++) {
    await sleep(250)
    control = client.entries.filter(isCspViolation)
  }
  if (control.length) {
    // The quoting in this message is Chrome's, and it is not consistent: the
    // directive is a bare word in some refusals and wrapped in double quotes in
    // others, so the quote is optional here rather than part of the name.
    const directive = control[0].text.match(/directive:\s*"?([^;"\s]+)/)?.[1]
    ok(
      `detector proven — a blocked image and fetch were reported (${directive ? `${directive}, ` : ''}${control.length} refusal(s))`,
    )
  } else {
    fail(
      `the detector did not fire: a blocked image and fetch produced no refusal report, so "no refusals" above proves nothing (is the policy permissive enough to allow them?)`,
    )
  }
  client.capturing = false
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
    ? `\n${failures} CSP check assertion(s) failed.`
    : '\nCSP check passed: the policy that ships is applied, the load is clean, and the detector fires.',
)
process.exit(failures ? 1 : 0)
