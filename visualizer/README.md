# wavi — browser music visualizer

A single-page visualizer: WebGL shader presets, audio-reactive analysis, synced
lyrics and Spotify playback (Web Playback SDK) in one window. Also plays local
audio files straight from the file picker or a drag-and-drop.

## Requirements

- Node 22+ and npm (CI runs on Node 22; `.nvmrc` pins 22 for the Pages build).
- A Spotify **Premium** account for in-app playback. Non-Premium still works for
  lyrics following — the Spotify app plays, and the visualizer listens.
- Optional: the bundled Chrome/Edge extension for capturing tab audio output
  (see `extension/README.md`). It is only needed to visualise Spotify output
  when the SDK isn't the audio source.

## Setup

```bash
cd visualizer
npm install
cp .env.example .env   # then fill in the two values below
npm run dev            # http://127.0.0.1:5173
```

`.env`:

| Variable | Meaning |
| --- | --- |
| `VITE_SPOTIFY_CLIENT_ID` | Client ID from the [Spotify dashboard](https://developer.spotify.com/dashboard). |
| `VITE_SPOTIFY_REDIRECT_URI` | Must match a Redirect URI registered on that app **exactly** (default `http://127.0.0.1:5173/callback`). |

Without a Client ID the app still runs: the visuals, local files and lyrics work,
and the Spotify panel reports that it isn't configured.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (proxies `/api/canvas`; production serves it from a Pages Function — see Deployment). |
| `npm run build` | `tsc -b` typecheck, then a production bundle into `dist/`. |
| `npm run typecheck` | Typecheck only. |
| `npm test` | Vitest unit tests (pure logic — no DOM, no network). |
| `npm run lint` | oxlint — fails on warnings too (`--deny-warnings`), see below. |
| `npm run check:viewport` | Headless-Chrome layout probe across phone/tablet/desktop viewports, plus a shader sweep of every preset against committed reference frames. |
| `npm run preview` | Serve the built bundle. |

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on every push and
pull request, plus a separate `viewport` job for the layout probe below.

### Lint policy

`npm run lint` runs with `--deny-warnings`, so any new warning fails CI rather
than accumulating. The react plugin's React Compiler advisories
(`react/immutability`, `react/refs`) are switched off for the per-frame engine
files in `.oxlintrc.json` — everything under `src/components/presets/` plus
`AmbientLyrics` and `BratLyrics` mutate ref-held uniforms and scratch buffers
every frame, and read refs during render to drive layout and animation, by
design. They stay on for every other file. Two deliberate `set-state-in-effect`
uses (the before-paint height measurement in `AmbientLyrics`, the song-key blank
in `BratLyrics`) carry an inline `oxlint-disable-next-line` with the reason at
the site.

## Responsive checks (`check:viewport`)

The stylesheets are split into nine files whose `@import` order is load-bearing,
so a same-specificity rule in `theme.css` silently cancels a touch rule in
`responsive.css` — no build error, no visual diff, just a control that is 28px
instead of 40px on a phone. `npm run check:viewport` exists to catch that:

```bash
npm run check:viewport                              # 6 default viewports, touch
npm run check:viewport -- --sizes 320x568 --pointer mouse
npm run check:viewport -- --url http://127.0.0.1:4173/   # probe vite preview
npm run check:viewport -- --presets none            # layout checks only
npm run check:viewport -- --presets mellow2 --software-gl   # render like CI
```

It starts vite if nothing is serving (and reuses your running dev server if it
is), drives the installed Chrome over the DevTools protocol, loads two generated
WAV fixtures so the player box actually exists, then reports per viewport:

- **failures** — page-level horizontal scroll, elements escaping the viewport,
  children spilling out of their container, off-screen regions, interactive
  targets under 24px, an error-boundary fallback, or a missing/unusable panel
  drawer handle below the 860px breakpoint. Exit code 1.
- **info** — clipped labels and targets under the comfortable 44px.

### Preset sweep (`--presets`, on by default)

Every id in `src/presets.ts` is also rendered once and checked for a clean mount.
This is the only automated check that catches a shader that stopped compiling:
three.js reports a GLSL compile or link failure with `console.error` and then
keeps drawing a black frame, so nothing throws, no error boundary fires, and the
layout checks above still pass. The id list is read out of the app rather than
duplicated here, so a new preset is swept without anyone remembering to extend
the probe.

The sweep runs at a fixed 390x844 touch viewport, deliberately *not* the first
`--sizes` entry: a captured frame can only be compared to a reference captured at
the same size, so the capture size has to be a constant rather than a function of
the flags.

A preset fails when the console reports an error, when its canvas is missing,
has no WebGL context, or lost it, when the `Scene` chunk's Suspense fallback
never clears, when an error boundary rendered, or when the `#p=` deep link did
not actually switch the preset — the Presets menu marks the current id with
`.checked`, and the sweep compares that against the id it asked for, so a sweep
cannot pass by silently rendering the same preset thirteen times. Failed
resource loads (the Google fonts, notably) are reported as info instead: they say
what the network looked like, not whether the app is broken.

### Reference frames (`scripts/probe-baselines/`)

Every swept preset is also captured and compared against a committed reference
frame, which is what catches a shader that compiles and mounts but no longer
looks right: a black or blank frame, the wrong palette, a uniform that stopped
being written. There is one JSON file per preset; each is 16 rows of 16 average
cell colours, small and diffable on purpose.

Three things make the comparison meaningful rather than flaky:

- **The animation clock is virtual** for the sweep only: `performance.now()`
  steps a fixed 200ms per animation frame and stops at exactly 12s. Every preset
  drives `uTime` from `state.clock.elapsedTime`, which three reads from that same
  value, and the analysis engine's envelopes advance off it too — on a real clock
  both would sit wherever the machine happened to be, and two runs of identical
  code would not match. The layout runs above stay on the real clock: an entrance
  animation frozen mid-flight would move the very things they measure.
- **The presets are driven with a fixed synthetic signal**, posted the way the
  browser extension posts it. Four of them (`amPreset`, `am2Preset`, `waveform`,
  `chromaticBurst`) draw nothing at all without one, so their references would be
  black; playing a real file instead would leave every band-reactive preset at a
  different point in the track on each run. The signal is a formula, not
  randomness, and the level it produces is recorded in each reference file.
- **It compares cell averages, not pixels.** CI has no GPU and renders through
  SwiftShader; a developer's machine renders on real hardware. Per-pixel noise
  lands differently between the two, the coarse structure lands the same way.

A frame fails when more than 8% of cells are off by more than 12/255 in any
channel. Measured on both renderers that allowance is currently dormant — no cell
of any preset is past the 12/255 tolerance, the worst being `auroraSilk` at 9
against the GPU-captured references and 1 on the GPU itself — so it is headroom
for a driver other than the two measured rather than a fix for a case that
exists. A thin high-contrast feature can land inside a cell on one driver and on
its boundary on another, which reads as one large delta and nothing else. The
reference frames were captured on a Radeon; `--software-gl` reruns the sweep on
SwiftShader and is how that independence is checked.

**A preset that rendered differently on different GPUs was fixed, not exempted.**
`auroraSilk` measured 235 of its 256 cells differing by up to 175/255 between a
GPU and SwiftShader, where every other preset is within 9. The cause was its
noise hash: the familiar `fract(sin(dot(p, k)) * 43758.5453)` multiplies a
`sin()` of an argument in the hundreds by ~4.4e4, and GL leaves the accuracy of
`sin()` at large arguments to the implementation, so a range-reduction difference
of a few units in the last place became a *different hash cell* — the noise field
decorrelated and whole regions flipped across its smoke threshold. It now hashes
without a sine, which every implementation evaluates identically, and the same
measurement is 0 cells past tolerance. All 13 presets are compared.
`RENDERER_SENSITIVE` in the probe is empty and kept, documented, as the escape
hatch for a preset that genuinely cannot be made renderer-independent; it reports
such a preset as *not compared* rather than counting it as covered.

What it also cannot tell you: a change confined to a small part of the frame, or
anything about motion. For an intended change of how a preset looks, run
`npm run check:viewport -- --presets <id> --update-baselines`, then commit the
regenerated file. A preset with no reference frame at all fails the run, so
adding one means recording it.

Options: `--server dev|preview`, `--sizes WxH,WxH`, `--pointer touch|mouse|both`,
`--presets all|none|id,id`, `--update-baselines`, `--software-gl`, `--json`,
`--strict` (fail on info too), `--no-audio`. Set `CHROME_PATH` (or `CHROME_BIN`)
if Chrome isn't in the usual place; otherwise it resolves one from `PATH`.

CI runs it in the `viewport` job — GitHub's ubuntu runners ship Chrome, so
nothing extra is installed — against the **built** bundle (`--server preview`)
at 390x844, 844x390, 1024x768 and 1440x900, with both pointer types, sweeps
every preset and compares all 13 reference frames — around three and a half
minutes for the whole job on SwiftShader. Run it locally whenever you touch
`src/styles/**`, a preset under `src/components/presets/`, or the narrow-viewport
behaviour in `App.tsx`.

## Architecture

```
src/
  main.tsx            entry — root error boundary, console noise filter
  App.tsx             shell: menus, keyboard shortcuts, OAuth callback,
                      extension bridge, transport wiring
  store.ts            zustand store; presets + UI prefs persist to localStorage
  queueIndex.ts       pure "what plays next" decision (shuffle/repeat/auto)
  audio.ts            local <audio> graph (AudioContext + analyser)
  analyser/           FFT/DSP pipeline behind the shader uniforms
  spotify.ts          OAuth PKCE + Web API client (typed errors, dedup refresh)
  spotifyPlayer.ts    Web Playback SDK wrapper
  spotifyQueue.ts     app-side queue over the loaded track list
  lyrics.ts           LRC parsing, ranking, LRCLib provider, localStorage cache
  components/         Shell, player box, lyrics, panels
  components/presets/ Scene's per-preset modules (one per shader) + shared
                      helpers (band reading, wave trace, AM tuning)
  styles/             CSS split by layer; index.css fixes the load order
extension/            MV3 tab-audio capture bridge (own README)
public/               copied verbatim into dist/: _headers, _routes.json, favicon
functions/api/        Pages Function serving /api/canvas (see Deployment)
```

Notes:

- **Shuffle and repeat are owned by Spotify**, not by the app queue: they are
  player state that governs natural track ends, so `spotifyQueue` pushes them
  onto the device and defers to Spotify's own queue while shuffle is on.
- **Local playback** uses `queueIndex.ts` for every transition (buttons *and*
  track ends), so both paths honour the same modes.
- `Scene` and the debug overlay are lazily imported to keep three.js out of the
  first paint.

## Deployment

Cloudflare Pages, with the project's **root directory set to `visualizer/`**
(build command `npm run build`, output directory `dist`). The deployment has no
`netlify.toml` and no `_redirects`: the parts of the old Netlify config had to
move into files that are only read from specific places, and a rule in the wrong
place is silently not applied at all:

| File | Read from | Why |
| --- | --- | --- |
| `public/_headers` | copied into `dist/` | Response headers, including the CSP. Pages never reads `netlify.toml`, so the header block that used to live there was not being sent by the host actually serving the site. |
| `public/_routes.json` | copied into `dist/` | Restricts Pages Functions to `/api/canvas`. Once a project has a `functions/` directory, **all** requests invoke a Function by default; this keeps static requests static (and free). |
| `functions/api/canvas.js` | project root, *not* the output dir | The Pages Function below. Resolved from the project's root directory, which is why that setting has to be `visualizer/` — if it were the repo root, this would have to move to the top level. |

`.nvmrc` pins Node 22 for the build. `package.json` `engines` is deliberately not
used for this: Pages' v3 build image ignores it (its Node default is already
22.16.0, so this is a pin rather than a fix).

### `/api/canvas`

A third-party service supplies the Canvas visuals. It sends no
`Access-Control-Allow-Origin` — verified by sending an `Origin` header — so the
browser cannot call it directly and the request has to leave from our own origin.
`functions/api/canvas.js` does that fetch server-side, so the client keeps
fetching `/api/canvas?trackId=…` unchanged, and the dev server proxies the same
path in `vite.config.ts` — **keep the two in sync**: a route proxied only in dev
works locally and breaks in production.

This is the one part of the old `netlify.toml` that had no Cloudflare
equivalent. Netlify did it with a `status = 200` rewrite, and `_redirects`
cannot reproduce it: proxying there "will only support relative URLs on your
site. You cannot proxy external domains."

The SPA catch-all is the other rule that was not ported, because Pages already
does it: with no top-level `404.html` in the output, unmatched paths render `/`.
That is what keeps the OAuth redirect working when
`VITE_SPOTIFY_REDIRECT_URI` points at a path like `/callback` — which is a
request for a file that does not exist. Two consequences worth knowing: adding a
`404.html` would silently break that redirect, and a `/* /index.html 200` proxy
rule would be a worse substitute, since `_redirects` rules are followed
regardless of whether a real asset matches — including the hashed assets in
`dist/assets/`.

### Security

Spotify access and refresh tokens live in `localStorage`
(`viz-spotify-tokens`) — the price of an authorization-code + PKCE flow with no
backend to hold them. Anything running on the page can read them, which is why
`public/_headers` sends an enforcing `Content-Security-Policy`. It shipped as
`-Report-Only` first, because the app reaches Spotify's SDK, its Web API and
lrclib.net, and a policy one origin short breaks playback with no visible cause.

If playback, lyrics or cover art stops working, look for a console message
starting `Refused to` and add the origin it names to the directive it names —
that message is the whole diagnosis. Note which parts a local run cannot reach:
neither `connect-src` to the Web API nor `img-src` for covers is exercised
without a real Spotify login, and the playback SDK's *own* traffic is inside its
`sdk.scdn.co` iframe, governed by Spotify's policy rather than this one — which is
why the SDK needs `frame-src`, not a wider `connect-src`.

Two directives are wildcarded over a CDN rather than naming hosts, because both
cover URLs the API hands out and that set changes:

- `img-src` over `*.scdn.co` and `*.spotifycdn.com`. Covers are whatever the Web
  API put in `album.images[].url` — editorial playlist mosaics, `*-images.scdn.co`,
  `image-cdn-*.spotifycdn.com`. A missing host is a silently blank cover on the
  ambient presets, not an error, which is how the earlier two-host list would
  have failed in production.
- `media-src` over `*.scdn.co`. Canvas videos are served from `canvaz.scdn.co`
  (measured: `/api/canvas` returns a `.cnvs.mp4` URL there), and `media-src` is
  the directive that governs a `<video>` element. It was `'self' blob:`, which
  blocks exactly that. The host itself is fine for the WebGL texture — it sends
  `Access-Control-Allow-Origin: *` and the preset sets `crossOrigin` — so the
  policy was the only thing in the way.

Nothing in CI reads `_headers`, and vite neither serves nor validates these
headers (`--server preview` sends none of them), so a policy regression is
invisible until production. The policy was checked by hand against the built
bundle, served with the header values parsed out of the config and loaded in
Chrome for 8 viewport runs and all 13 presets: zero violations, with the detector
proven first by dropping a font origin and watching the violation appear. The
`media-src` rule above is **not** covered by that check — canvas playback needs a
real Spotify login — which is why it rests on the two measurements recorded here
instead.

## Known limitations

- Shuffle plays endlessly: the local transport draws random tracks rather than
  walking a shuffled deck, so "shuffle + repeat off" never reaches an end, and
  Previous picks a random track instead of the previous one played.
- Lyrics come from a single upstream (LRCLib) with no fallback provider.
- Playlist loading is capped at 500 tracks.
