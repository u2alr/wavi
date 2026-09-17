# wavi — browser music visualizer

A single-page visualizer: WebGL shader presets, audio-reactive analysis, synced
lyrics and Spotify playback (Web Playback SDK) in one window. Also plays local
audio files straight from the file picker or a drag-and-drop.

## Requirements

- Node 22+ and npm (CI runs on Node 22; Netlify pins its own `NODE_VERSION`).
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
| `npm run dev` | Vite dev server (proxies `/api/canvas`, see Deployment). |
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

Two things make the comparison meaningful rather than flaky:

- **The animation clock is frozen** (to `uTime` 12s) for the sweep only. Every
  preset drives `uTime` from `state.clock.elapsedTime`, which three reads from
  `performance.now()`, so an unfrozen frame differs slightly on every run and a
  reference would mean nothing. The layout runs above stay on the real clock: an
  entrance animation frozen mid-flight would move the very things they measure.
- **It compares cell averages, not pixels.** CI has no GPU and renders through
  SwiftShader; a developer's machine renders on real hardware. Per-pixel noise
  lands differently between the two, the coarse structure lands the same way.

A frame fails when more than 8% of cells are off by more than 12/255 in any
channel — the allowance is there because a thin high-contrast feature (aurora
silk's brightest ribbons) can land inside a cell on one renderer and on its
boundary on another, which reads as one large delta and nothing else. The
reference frames were captured on a Radeon; `--software-gl` reruns the sweep on
SwiftShader and is how that independence is checked.

**Four presets are not covered by this, and the run says so.** `amPreset`,
`am2Preset`, `waveform` and `chromaticBurst` draw nothing at all without audio,
and the sweep loads none (it renders in silence for the sake of a stable frame —
a playing track would make every band-reactive preset different on each run).
Their reference frames are black, which could only ever catch "it started
drawing something", so the run reports them as *not compared* instead of a pass.
They are still covered by the compile, mount and console checks above; what is
missing is their look.

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
every preset and compares the frames it can. Run it locally whenever you touch
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

`netlify.toml` builds `npm run build` and publishes `dist`, and proxies
`/api/canvas` to a third-party service that supplies Canvas visuals. The dev
server mirrors that rewrite in `vite.config.ts` — **keep the two in sync**: a
route proxied only in dev works locally and breaks in production. The proxy rule
is declared before the SPA catch-all for the same reason: `/*` matches every
path, so a rule listed after it only ever works in dev.

### Security

Spotify access and refresh tokens live in `localStorage`
(`viz-spotify-tokens`) — the price of an authorization-code + PKCE flow with no
backend to hold them. Anything running on the page can read them, which is why
`netlify.toml` sends a Content-Security-Policy. It is staged as
`Content-Security-Policy-Report-Only` on purpose: the app reaches Spotify's SDK,
its Web API and lrclib.net, and a policy one origin short breaks playback with
no visible cause. Deploy, load the site once with lyrics and a Spotify connect,
check the console for violations, then rename the header to
`Content-Security-Policy`.

## Known limitations

- Shuffle plays endlessly: the local transport draws random tracks rather than
  walking a shuffled deck, so "shuffle + repeat off" never reaches an end, and
  Previous picks a random track instead of the previous one played.
- Lyrics come from a single upstream (LRCLib) with no fallback provider.
- Playlist loading is capped at 500 tracks.
