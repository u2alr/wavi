// Pages Function: the production half of /api/canvas.
//
// The canvas service sends no Access-Control-Allow-Origin (checked by sending an
// Origin header), so the browser cannot call it directly and the request has to
// leave from our own origin. Netlify did that with a `status = 200` rewrite.
// Cloudflare cannot port that rule: proxying in _redirects "will only support
// relative URLs on your site. You cannot proxy external domains." A Function is
// the equivalent.
//
// Plain JS on purpose. tsconfig.app.json includes only src/ and
// tsconfig.node.json only vite.config.ts, so a .ts file in here would look
// typed while `npm run typecheck` never read it — an unchecked file that
// appears verified. scripts/ is plain JS for the same reason.
//
// Routing: public/_routes.json lists only /api/canvas. Without that file, the
// presence of this directory routes every request on the site through a
// Function invocation.

const UPSTREAM = 'https://spotify-canva.vercel.app/api/canvas'

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

export async function onRequestGet({ request }) {
  const trackId = new URL(request.url).searchParams.get('trackId')
  if (!trackId) return json({ error: 'missing trackId' }, 400)

  let upstream
  try {
    upstream = await fetch(`${UPSTREAM}?trackId=${encodeURIComponent(trackId)}`)
  } catch {
    // Unreachable upstream. 502 rather than 500 — the failure is not ours — and
    // the client treats any non-2xx the same way (album art), so the status is
    // for whoever is reading logs.
    return json({ error: 'canvas service unreachable' }, 502)
  }

  if (!upstream.ok) return json({ error: 'canvas service error', status: upstream.status }, 502)

  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    // A 200 that is not a payload: the client calls res.json(), so returning an
    // error page under a JSON content-type would surface as an unexplained parse
    // failure in the browser instead of a status it can read.
    return json({ error: 'canvas service returned non-JSON' }, 502)
  }

  // Passed through unchanged: the client reads canvasesList[0].canvasUrl and
  // treats a missing canvas as "fall back to album art", exactly like the empty
  // list the service returns for a track that has none. Caching is deliberately
  // off, because "no canvas yet" is a state that can change.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
