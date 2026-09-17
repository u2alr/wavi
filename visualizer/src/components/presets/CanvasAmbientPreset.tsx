import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData } from '../../audio'
import { readBands } from './bands'

function useCanvasSource() {
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  // Primitive identity for the effect below: the store hands out a fresh track
  // OBJECT on every SDK state event, so depending on the object would restart
  // the canvas lookup — and reload the video — mid-track.
  const trackId = spotifyCurrentTrack?.id ?? null
  const [source, setSource] = useState<{ tex: THREE.Texture | null; aspect: number }>({ tex: null, aspect: 1 })

  useEffect(() => {
    let dead = false
    let dispose: (() => void) | null = null

    const makeVideo = (url: string, aspect: number) => {
      const video = document.createElement('video')
      video.src = url
      video.crossOrigin = 'anonymous'
      video.loop = true
      video.muted = true
      video.playsInline = true
      video.play().catch(() => {})
      const tex = new THREE.VideoTexture(video)
      tex.colorSpace = THREE.SRGBColorSpace
      if (!dead) {
        setSource({ tex, aspect })
        dispose = () => { video.pause(); video.removeAttribute('src'); tex.dispose() }
      }
    }

    const makeImage = (url: string) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        if (!dead) { setSource({ tex, aspect: 1 }); dispose = () => tex.dispose() }
      })
    }

    ;(async () => {
      // Read the track at call time; it is used only for the album-art fallback,
      // while trackId above carries the effect's identity.
      const track = useStore.getState().spotifyCurrentTrack
      if (!trackId) return

      try {
        // 🪄 Just fetch your own local path! The proxy handles the rest.
        const res = await fetch(`/api/canvas?trackId=${encodeURIComponent(trackId)}`)
        if (!res.ok) throw new Error('proxy error')

        const data = await res.json()
        const canvasUrl = data?.canvasesList?.[0]?.canvasUrl
        if (!canvasUrl) throw new Error('no canvas for this track')

        makeVideo(canvasUrl, 9 / 16)
      } catch {
        // Fallback to album art if no canvas exists
        const art = track?.album?.images?.[0]?.url
        if (art) makeImage(art)
      }
    })()

    return () => { dead = true; dispose?.() }
  }, [trackId])

  return source
}

export default function CanvasAmbientPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((s) => s.viewport)
  const { tex, aspect } = useCanvasSource()
  const bandsScratch = useMemo(() => ({ bass: 0, mid: 0, treble: 0 }), [])

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uAspect: { value: 1 },
      uTex: { value: null as THREE.Texture | null }, uHasTex: { value: 0 },
      uArtAspect: { value: 1 },
      uArtSize: { value: 0.60 },      // half-height of the artwork (0.5 small · 0.9 huge)
      uRadius: { value: 0.04 },       // corner roundness (0 square · 0.12 very round)
      uBgDark: { value: 0.55 },       // background dim (0 = bright wash · 0.8 = near black)
      uPulse: { value: 2.0 },         // bass reactivity of bg + breathing (0 = static)
      uShadow: { value: 0.45 },       // drop shadow behind artwork (0 = off)
      uArtDim: { value: 3.0},       // artwork brightness (0.4 dark · 0.65 normal · 1.0 full)
      uArtSaturation: { value: 0.75 },// artwork saturation (0.5 muted · 0.75 normal · 1.2 vibrant)
      uArtContrast: { value: 0.9 },  // artwork contrast (0.8 flat · 1.0 normal · 1.3 punchy)
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBass,uAspect,uHasTex,uArtAspect,uArtSize,uRadius,uBgDark,uPulse,uShadow;
      uniform float uArtDim,uArtSaturation,uArtContrast;
      uniform sampler2D uTex;

      float rbox(vec2 p, vec2 b, float r){
        vec2 q=abs(p)-b+r;
        return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;
      }

      // Desaturate/saturate helper
      vec3 adjustSaturation(vec3 col, float sat) {
        float gray = dot(col, vec3(0.299, 0.587, 0.114));
        return mix(vec3(gray), col, sat);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        // artwork rect, breathing slightly with the bass
        float H=uArtSize;
        float W=H*uArtAspect;
        vec2 q=p/(1.0+uBass*0.02*uPulse);

        float d=rbox(q, vec2(W,H), uRadius);
        float mask=(1.0-smoothstep(-0.008,0.008,d))*uHasTex;
        vec2 uvArt=clamp(q/(2.0*vec2(W,H))+0.5, 0.0, 1.0);

        vec3 art=uHasTex>0.5 ? texture2D(uTex,uvArt).rgb : vec3(0.0);

        // TONE DOWN THE ARTWORK
        art *= uArtDim;                          // dim overall
        art = adjustSaturation(art, uArtSaturation); // reduce saturation
        art = (art - 0.5) * uArtContrast + 0.5;  // boost contrast slightly

        // subtle vignette on the artwork itself
        float artVig = 0.8 - smoothstep(0.6, 1.0, length(uvArt - 0.5) * 1.8);
        art *= mix(0.7, 1.0, artVig);

        // ambient background = averaged artwork color (like your ref)
        vec3 avg;
        if(uHasTex>0.5){
          avg =texture2D(uTex,vec2(0.5,0.5)).rgb;
          avg+=texture2D(uTex,vec2(0.25,0.5)).rgb;
          avg+=texture2D(uTex,vec2(0.75,0.5)).rgb;
          avg+=texture2D(uTex,vec2(0.5,0.25)).rgb;
          avg+=texture2D(uTex,vec2(0.5,0.75)).rgb;
          avg/=5.0;
        } else {
          avg=vec3(0.16,0.10,0.04); // warm fallback (your screenshot's brown)
        }

        float vig=1.0-smoothstep(0.4,2.4,length(p))*0.55;
        vec3 bg=avg*(1.0-uBgDark)*vig;
        bg*=0.85+uBass*0.35*uPulse;

        // soft drop shadow hugging the rounded rect
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
    u.uTex.value = tex
    u.uHasTex.value = tex ? 1 : 0
    u.uArtAspect.value = aspect
  }, [tex, aspect])

  useFrame((state) => {
    const b = readBands(getFreqData(), bandsScratch)
    const { sensitivity, speed } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = Math.min(b.bass * sensitivity, 1.5)
    u.uAspect.value = viewport.width / viewport.height
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}
