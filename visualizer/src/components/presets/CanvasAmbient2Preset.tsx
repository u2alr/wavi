import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { extractPalette, FALLBACK_PALETTE, PALETTE_STOPS, type Rgb } from '../../coverPalette'

// Side of the downscaled cover used as the ambient bleed source. Small on
// purpose: at this size the GPU's bilinear upscale IS the blur.
const BLEED_TEX_SIZE = 24

/**
 * Cover preview + palette in one pass for the Canvas Ambient 2 background: a
 * center-cropped 24px copy of the cover (the GPU's bilinear upscale of it is
 * the heavy blur) and the vivid palette read off those same pixels. One
 * downscale, one upload, one read-back per track. Null when the image or a 2D
 * context is unavailable; `palette` alone goes null when the canvas is
 * tainted (no CORS), in which case the caller keeps its current colors.
 */
function makeCoverPreview(img: HTMLImageElement | undefined | null): {
  tex: THREE.CanvasTexture
  palette: Rgb[] | null
} | null {
  if (!img?.width || !img?.height) return null
  const canvas = document.createElement('canvas')
  canvas.width = BLEED_TEX_SIZE
  canvas.height = BLEED_TEX_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // Center crop to a square so the shader can cover-fit without distorting.
  const side = Math.min(img.width, img.height)
  ctx.drawImage(
    img,
    (img.width - side) / 2, (img.height - side) / 2, side, side,
    0, 0, BLEED_TEX_SIZE, BLEED_TEX_SIZE,
  )
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping

  let palette: Rgb[] | null = null
  try {
    palette = extractPalette(ctx.getImageData(0, 0, BLEED_TEX_SIZE, BLEED_TEX_SIZE).data)
  } catch {
    // Tainted canvas (cover served without CORS) — bg keeps its palette.
    palette = null
  }
  return { tex, palette }
}

type CoverArt = {
  tex: THREE.Texture | null
  bleed: THREE.Texture | null
  palette: Rgb[] | null
  aspect: number
}

// Nothing loaded — a track without a cover, or one that just lost it. Uniforms
// are reset from this constant, so the effect below never has to write state
// synchronously; the loader's cleanup disposes the previous textures.
const NO_ART: CoverArt = { tex: null, bleed: null, palette: null, aspect: 1 }

/**
 * Canvas Ambient 2 — calm Apple Music-style gradient. Artwork card shows
 * the album cover directly (no canvas video); the background combines the
 * cover's own vivid palette (a smooth five-stop ramp) with a warped, heavily
 * blurred bleed of the cover itself (makeCoverPreview), so the wash is
 * literally the album's colors and travels with the music's flow field.
 * No audio reactivity by design — the palette lerps toward each new cover
 * (~1.5s) so track changes crossfade instead of cutting.
 */
export default function CanvasAmbient2Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((s) => s.viewport)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const coverUrl = track?.album?.images?.[0]?.url
  // Cover texture loaded directly (v1 keeps using useCanvasSource), plus the
  // 24px preview + palette behind the ambient wash (see makeCoverPreview).
  const [art, setArt] = useState<CoverArt>(NO_ART)
  useEffect(() => {
    if (!coverUrl) return
    let dead = false
    let loaded: THREE.Texture | null = null
    let bleedLoaded: THREE.CanvasTexture | null = null
    new THREE.TextureLoader().load(coverUrl, (t) => {
      if (dead) {
        t.dispose()
        return
      }
      t.colorSpace = THREE.SRGBColorSpace
      const img = t.image as HTMLImageElement | undefined
      const preview = makeCoverPreview(img)
      loaded = t
      bleedLoaded = preview?.tex ?? null
      setArt({
        tex: t,
        bleed: preview?.tex ?? null,
        palette: preview?.palette ?? null,
        aspect: img?.width && img?.height ? img.width / img.height : 1,
      })
    })
    return () => {
      dead = true
      loaded?.dispose()
      bleedLoaded?.dispose()
    }
  }, [coverUrl])
  // While a new cover loads — or when there is none — this reads as
  // nothing-loaded without a state write.
  const coverArt = coverUrl ? art : NO_ART
  // Displayed palette — lerped toward the sampled target every frame.
  const paletteRef = useRef<Rgb[]>(FALLBACK_PALETTE.map((c) => [...c] as Rgb))

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uAspect: { value: 1 },
      uTex: { value: null as THREE.Texture | null }, uHasTex: { value: 0 },
      uBleedTex: { value: null as THREE.Texture | null }, uHasBleed: { value: 0 },
      uArtAspect: { value: 1 },
      uArtSize: { value: 0.58 },
      uArtX: { value: -0.88 },       // left half — lyrics live on the right
      uArtY: { value: 0.10 },
      uRadius: { value: 0.02 },
      uShadow: { value: 0.15 },
      uArtDim: { value: 3.0 },
      uArtSaturation: { value: 0.75 },
      uArtContrast: { value: 0.9 },
      uBgZoom: { value: 2.1 },       // bleed zoom (1 = cover-fit · 2+ = abstract)
      uBgBright: { value: 2.2 },     // bleed brightness (samples arrive linear)
      uBgSat: { value: 1.15 },       // bleed saturation (1 = untouched)
      uBgWarp: { value: 0.09 },      // how far the field warps the bleed (uv)
      uBgBleed: { value: 0.85 },     // 1 = cover bleed only · 0 = palette only
      uBleedTexel: { value: 1 / BLEED_TEX_SIZE },
      uPal: { value: FALLBACK_PALETTE.map((c) => new THREE.Vector3(...c)) },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uAspect,uHasTex,uArtAspect,uArtSize,uArtX,uArtY,uRadius,uShadow;
      uniform float uArtDim,uArtSaturation,uArtContrast,uHasBleed,uBgZoom,uBgBright,uBgSat;
      uniform float uBgWarp,uBgBleed,uBleedTexel;
      uniform vec3 uPal[5];
      uniform sampler2D uTex;
      uniform sampler2D uBleedTex;

      float rbox(vec2 p, vec2 b, float r){
        vec2 q=abs(p)-b+r;
        return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;
      }

      vec3 adjustSaturation(vec3 col, float sat) {
        float gray = dot(col, vec3(0.299, 0.587, 0.114));
        return mix(vec3(gray), col, sat);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        // Blurred-cover bleed background, Apple Music style, built from lava-
        // lamp lumps instead of noise:
        //   lumps  — a handful of slow-drifting metaballs, one palette stop
        //            each. Summed Gaussian influence, no octaves and no domain
        //            warping, so shapes stay rounded and soft-centred while
        //            they swell, merge and split. The wide smoothstep below is
        //            the blur: edges go out of focus rather than fray to smoke.
        //            Carries the whole bg with no cover, and tints it when
        //            there is one.
        //   bleed  — the 24px cover preview, cover-fit then zoomed past the
        //            frame, drifting so the colors move with the lumps instead
        //            of sliding over them. The preview is small enough that the
        //            GPU's bilinear upscale is most of the blur; ring taps at
        //            whole texels mop up the last bilinear facets.
        // Nothing from audio.
        float t=uTime*0.06;
        vec2 q=p*vec2(0.66,1.02);

        vec3 lumpCol=vec3(0.0);
        float lumpW=0.0;
        float field=0.0;
        for(int i=0;i<5;i++){
          float fi=float(i);
          // each lump wanders on its own slow lissajous so they never lockstep
          vec2 c=vec2(sin(t*(0.13+fi*0.021)+fi*2.4)*0.62,
                      cos(t*(0.11+fi*0.017)+fi*1.7)*0.48);
          // breathing radius: lumps swell and shrink like wax in the tube
          float r=0.36+0.07*sin(t*0.09+fi*1.9);
          float dx=q.x-c.x, dy=q.y-c.y;
          float w=exp(-(dx*dx+dy*dy)/(r*r));
          field+=w;
          lumpCol+=uPal[i]*w;
          lumpW+=w;
        }
        lumpCol/=max(lumpW,0.0001);
        float lumps=smoothstep(0.40,1.30,field);

        // base wash under the lumps: smooth palette ramp, no noise at all
        float ramp=clamp(0.5+0.5*dot(q,vec2(0.34,0.52)),0.0,1.0);
        vec3 palBg=mix(uPal[0],uPal[1],smoothstep(0.0,0.8,ramp));

        // cover the viewport with the square preview, zoom past it, then drift
        vec2 coverScale=uAspect>1.0 ? vec2(1.0/uAspect,1.0) : vec2(1.0,uAspect);
        float zb=uBgZoom*(1.0+0.02*sin(uTime*0.05));
        vec2 pan=vec2(sin(uTime*0.07),cos(uTime*0.061))*0.02;
        // noise-free drift for the sample point: structure, not smoke
        vec2 warp=0.5+0.5*vec2(sin(q.y*0.9+t*0.7),cos(q.x*0.8-t*0.6));
        vec2 buv=(vUv-0.5)*(coverScale/zb)+0.5+pan+(warp-0.5)*uBgWarp;
        float tx=uBleedTexel;
        vec3 bleed=texture2D(uBleedTex,buv).rgb*0.30
          +(texture2D(uBleedTex,buv+vec2(tx,0.0)).rgb+texture2D(uBleedTex,buv-vec2(tx,0.0)).rgb
          +texture2D(uBleedTex,buv+vec2(0.0,tx)).rgb+texture2D(uBleedTex,buv-vec2(0.0,tx)).rgb)*0.10
          +(texture2D(uBleedTex,buv+vec2(tx,tx)).rgb+texture2D(uBleedTex,buv-vec2(tx,tx)).rgb
          +texture2D(uBleedTex,buv+vec2(tx,-tx)).rgb+texture2D(uBleedTex,buv+vec2(-tx,tx)).rgb)*0.075;
        bleed=adjustSaturation(bleed,uBgSat)*uBgBright;
        bleed*=0.96+0.08*warp.y;

        // palette builds the lumps, the cover stays in the gaps between them
        vec3 bg=mix(palBg,lumpCol,lumps);
        bg+=lumpCol*pow(lumps,2.0)*0.22;                  // soft lit cores
        bg=mix(bg,bleed*(0.65+0.55*lumps),uHasBleed*uBgBleed*0.72);
        // vignette: corners/edges fall away, matching the reference frame
        float vig=1.0-smoothstep(0.35,2.6,length(p))*0.45;
        bg*=vig;

        // artwork card (same treatment as v1). Split layout on wide
        // canvases: card on the left, lyrics DOM on the right. Narrow
        // (portrait) canvases stack: card centered above bottom lyrics.
        float H=uArtSize;
        float W=H*uArtAspect;
        float split=step(1.0,uAspect);
        vec2 cardC=mix(vec2(0.0,0.42),vec2(uArtX,uArtY),split);
        vec2 aq=(p-cardC);

        float d=rbox(aq, vec2(W,H), uRadius);
        float mask=(1.0-smoothstep(-0.008,0.008,d))*uHasTex;
        vec2 uvArt=clamp(aq/(2.0*vec2(W,H))+0.5, 0.0, 1.0);

        vec3 art=uHasTex>0.5 ? texture2D(uTex,uvArt).rgb : vec3(0.0);
        art *= uArtDim;
        art = adjustSaturation(art, uArtSaturation);
        art = (art - 0.5) * uArtContrast + 0.5;
        float artVig = 0.8 - smoothstep(0.6, 1.0, length(uvArt - 0.5) * 1.8);
        art *= mix(0.7, 1.0, artVig);

        float shadow=exp(-max(d,0.0)*6.0)*uShadow;

        vec3 col=bg*(1.0-shadow);
        col=mix(col,art,mask);

        col=col/(1.0+col*0.6);
        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useEffect(() => {
    const u = materialRef.current.uniforms
    u.uTex.value = coverArt.tex
    u.uBleedTex.value = coverArt.bleed
    u.uHasTex.value = coverArt.tex ? 1 : 0
    u.uHasBleed.value = coverArt.bleed ? 1 : 0
    u.uArtAspect.value = coverArt.aspect
  }, [coverArt])

  // Palette read off the cover's own pixels; the muted useArtGradient stops
  // belong to the player box, not to a full-screen wash, so this preset runs
  // on its own vivid extraction (falling back while nothing has loaded).
  const targetPalette = coverArt.palette ?? FALLBACK_PALETTE

  useFrame((state, delta) => {
    const { speed } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uAspect.value = viewport.width / viewport.height
    // Exponential ease toward the sampled palette — gentle crossfade.
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 2.0)
    const cur = paletteRef.current
    const pal = u.uPal.value as THREE.Vector3[]
    for (let i = 0; i < PALETTE_STOPS; i++) {
      for (let c = 0; c < 3; c++) cur[i][c] += (targetPalette[i][c] - cur[i][c]) * k
      pal[i].set(cur[i][0], cur[i][1], cur[i][2])
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}
