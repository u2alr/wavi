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
| `npm run check:csp` | Serves `dist/` with `public/_headers` applied and fails on any Content-Security-Policy refusal (see Security). |
| `npm run check:presets` | Mounts every preset in Chrome and fails on a console or GL error, a missing WebGL context, or a `#p=` link that did not apply (see Preset smoke pass). |
| `npm run preview` | Serve the built bundle. |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and a build on every
push and pull request, then the policy check below.

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

## Architecture

```
src/
  main.tsx            entry — root error boundary, console noise filter
  App.tsx             shell: menus, keyboard shortcuts, OAuth callback,
                      extension bridge, transport wiring
  store.ts            zustand store; presets + UI prefs persist to localStorage
  queueIndex.ts       pure "what plays next" decision (shuffle/repeat/auto)
  audio.ts            local <audio> graph (AudioContext + analyser)
  windowFocus.ts      focus/visibility predicate behind "pause when unfocused"
  frameStats.ts       rendered frames per second, counted inside the canvas
  renderScale.ts      adaptive canvas resolution, for GPUs that cannot fill it
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
- **An unfocused window stops drawing.** `windowFocus.ts` parks the render
  loop (`frameloop="never"`) and the analysis pipeline when the tab is hidden
  or focus has been away for 250ms, and resumes on focus. Playback is untouched
  — the local player is an `<audio>` element behind the Web Audio graph and
  Spotify's runs in the SDK's iframe, so neither ever depended on the render
  loop, and the shader clock keeps running so the visuals stay in step with the
  audio. Tools → *Pause When Unfocused* turns it off (the setting persists).
  The 250ms delay is what stops focus moving inside the page — into the Spotify
  SDK's iframe, say — from flickering the scene off and on.
- **The status bar's FPS is the renderer's own rate**, counted per drawn frame
  inside the canvas (`frameStats.ts`). Measuring this page's
  `requestAnimationFrame` instead — which is what it used to do — reports the
  display's refresh rate no matter what the frame-rate cap is doing, so a cap of
  30 still read as 60 and the cap looked inert. It reads 0 while the scene is
  parked, which makes the status bar a way to see the pause working.
- **Canvas resolution adapts to the machine.** Every preset is one full-screen
  fragment shader, so a frame costs pixels × shader cost, and the only lever
  that cuts that without changing the look is filling fewer pixels.
  `renderScale.ts` drops the canvas' device pixel ratio (floor 0.6 — 36% of the
  pixels) after two consecutive windows draw under a third of the rate the cap
  asked for, and returns to full resolution when the preset or the cap changes.
  Measured on a software rasteriser at a fixed canvas size: 16 fps at full
  resolution, 32–35 fps at the floor. It deliberately does not compare against
  the display's refresh rate: the drawing happens on the thread that serves
  `requestAnimationFrame`, so the measured cadence *is* the rate the app is
  achieving, and the comparison would be a number against itself. The trade is
  that the cap and the display are different numbers, so a display genuinely
  running at a third of the cap is indistinguishable from a machine that cannot
  keep up; the water mark sits below the ordinary case (a 60Hz panel holding
  the default 120 cap is at half the target), so healthy machines never move.
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

### Policy check (`check:csp`)

Vite neither reads `_headers` nor sends it, so the policy that ships is invisible
to the dev server, to `vite preview` and to every unit test. `npm run check:csp`
is what covers it: it serves `dist/` in-process with the file's rules applied
plus the SPA fallback Pages uses, then loads the app under that policy in Chrome.
Run `npm run build` first. Four assertions come out of that one load, and the
last is what makes the first three worth anything:

- **the served policy is the policy written in the file** — the response for `/`
  carries exactly the `Content-Security-Policy` the file declares, so "no
  refusals" cannot be reported by a file that declares none.
- **the load is clean** — any refusal is a failure naming the directive and the
  blocked URL, classified *before* resource-load noise: the refusal for the
  Google font stylesheet contains `fonts.googleapis.com`, so the noise pattern
  would otherwise swallow the exact thing the check exists to catch.
- **the app rendered** — a 404 or a blank document violates nothing, so "clean"
  is not reported for a page that never loaded.
- **the detector fires** — a deliberately blocked image and `fetch` are injected
  and at least one refusal must come back, or the run fails saying the clean
  result above proves nothing. Both are refused before any DNS lookup, so this
  needs no network.

The guards have been checked against themselves, because a policy check that
cannot fail is worse than none: with the font origin removed from `style-src` the
run exits 1 naming `style-src 'self' 'unsafe-inline'` and the blocked stylesheet,
and with a rule pattern that stops covering `/` it exits 1 saying the declared
policy does not apply there.

What it cannot reach is a path a run never takes: covers and the Web API need a
Spotify login, and canvas playback needs a real track. The `media-src` rule above
is exactly such a path, so it rests on the two measurements recorded here rather
than on a test.

### Preset smoke pass (`check:presets`)

`npm run check:presets` loads every id in `src/presets.ts` through its own `#p=`
deep link in headless Chrome and reports whether each one mounted cleanly. It
exists because a shader that fails to compile is invisible to everything else
here: three.js reports GLSL compile and link failures with `console.error` and
carries on drawing a black frame, so nothing throws, no error boundary fires, and
no typecheck, lint or unit test can see it. The failure appears only on the
device of whoever looks at that preset.

Per preset it fails on an error boundary rendering, a canvas with no WebGL
context, a lost context, a `.canvas-loading` fallback that never cleared, and any
console error, uncaught exception or thrown error in the render loop. A failed
resource load is reported and not failed — it says what this network looked like,
not whether the preset is broken.

The mount check alone is not enough, and the sweep would pass while rendering the
same preset twelve times, so each run is confirmed against the Presets menu,
which marks the current id with `.checked`. That is the anti-vacuity control: if
no deep link can be confirmed, the run fails rather than reporting twelve clean
mounts it cannot attribute. Each preset is also fed the same fixed synthetic
spectrum, posted the way the browser extension posts it, because `amPreset`,
`am2Preset`, `waveform` and `chromaticBurst` draw nothing at all without a signal
and their shaders would go unexercised.

**No reference frames.** This checks that a preset mounts and draws without
error, never what it looks like, so a preset that compiles and draws the wrong
thing — black, the wrong palette, frozen, ignoring its sliders — passes. Closing
that needs a committed frame per preset and a comparison tolerant of
renderer-to-renderer noise, which then has to be regenerated on every intended
look change; that check existed here and was removed deliberately.

Run `npm run build` first. `--presets=<id,id>` sweeps a subset (or `none`), and
`--software-gl` renders through SwiftShader, which is how CI's renderer can be
reproduced on a machine that has a GPU. Same shape as the policy check above:
both serve `dist/` in-process from `scripts/lib/harness.mjs` and drive Chrome
over the DevTools protocol, with no automation dependency.

The guards have been checked against themselves the same way: a deliberate
GLSL type error in one preset's fragment shader exits 1 quoting three's
`THREE.WebGLProgram: Shader Error` and the failing line, while the next preset in
the same run still passes; and with the `#p=` handling disabled the run exits 1
saying the menu marks `mellow2` where the URL asked for `amPreset` — the failure
the control exists to produce.

## Known limitations

- Shuffle plays endlessly: the local transport draws random tracks rather than
  walking a shuffled deck, so "shuffle + repeat off" never reaches an end, and
  Previous picks a random track instead of the previous one played.
- Lyrics come from a single upstream (LRCLib) with no fallback provider.
- Playlist loading is capped at 500 tracks.
