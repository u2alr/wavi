import { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../store'
import { getFreqData, getSampleRate, getExtensionWaveData } from '../audio'
import { getEmberWaveAnalyser, teardownEmberWaveAnalyser } from '../emberAnalyser'
import { getAnalysis, readVisualBands } from '../analyser'
import { extractPalette, FALLBACK_PALETTE, PALETTE_STOPS, type Rgb } from '../coverPalette'


const edgeCache = new Map<string, number[]>()

function readBands(frequency: Uint8Array, out = { bass: 0, mid: 0, treble: 0 }) {
  let bass = 0, mid = 0, treble = 0
  const bassEnd = Math.floor(frequency.length * 0.1)
  const midEnd = Math.floor(frequency.length * 0.4)
  for (let i = 0; i < bassEnd; i++) bass += frequency[i]
  for (let i = bassEnd; i < midEnd; i++) mid += frequency[i]
  for (let i = midEnd; i < frequency.length; i++) treble += frequency[i]
  out.bass = bass / (bassEnd * 255)
  out.mid = mid / ((midEnd - bassEnd) * 255)
  out.treble = treble / ((frequency.length - midEnd) * 255)
  return out
}

// Uniform keys for the 3-band envelope followers — module const so the
// per-frame loop never allocates a key array.
const BAND_UNIFORMS = ['uBass', 'uMid', 'uTreble'] as const

/** 7-band split (sub → low → low-mid → mid → high-mid → high → air) for
 * contour-style presets where each band owns its own visual channel. */
function hzBandEdges(bandCount: number, binCount: number, sampleRate: number, minFreq = 20, maxFreq = 20000) {
  const key = `${bandCount}:${binCount}:${sampleRate}`
  const cached = edgeCache.get(key)
  if (cached) return cached

  const nyquist = sampleRate / 2
  const binHz = nyquist / binCount
  const top = Math.min(maxFreq, nyquist)
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(top)

  const edges: number[] = []
  for (let i = 0; i <= bandCount; i++) {
    const hz = Math.pow(10, logMin + (i / bandCount) * (logMax - logMin))
    edges.push(hz / binHz)
  }
  edgeCache.set(key, edges)
  return edges
}

function sumBands(frequency: Uint8Array, binEdges: number[], bandCount: number, out: number[]) {
  for (let b = 0; b < bandCount; b++) {
    const startBin = binEdges[b]
    const endBin = Math.max(startBin + 1, binEdges[b + 1])
    let sum = 0, weight = 0
    const i0 = Math.floor(startBin)
    const i1 = Math.min(frequency.length - 1, Math.ceil(endBin) - 1)
    for (let i = i0; i <= i1; i++) {
      const overlap = Math.min(i + 1, endBin) - Math.max(i, startBin)
      if (overlap <= 0) continue
      sum += frequency[i] * overlap
      weight += overlap
    }
    out[b] = weight > 0 ? sum / (weight * 255) : 0
  }
  return out
}

function readBands7(frequency: Uint8Array, out: number[]) {
  const edges = hzBandEdges(7, frequency.length, getSampleRate())
  return sumBands(frequency, edges, 7, out)
}

function Mellow2Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  // Reused every frame — readBands writes in place, zero per-frame garbage.
  const bandsScratch = useMemo(() => ({ bass: 0, mid: 0, treble: 0 }), [])
  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBass,uMid,uTreble,uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;

      float hash(vec2 p){
        vec3 p3=fract(vec3(p.xyx)*0.1031);
        p3+=dot(p3,p3.yzx+33.33);
        return fract((p3.x+p3.y)*p3.z);
      }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      float fbm3(vec2 p){
        float v=0., a=0.55;
        for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.52; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;
        
        float bass=min(uBass*uSensitivity,1.5);
        float mid=min(uMid*uSensitivity,1.5);
        float high=min(uTreble*uSensitivity,1.5);

        float t=uTime*0.10;
        float detail=1.6+uComplexity*0.8;

        vec2 q=vec2(fbm3(p*detail+vec2(0.0,t*0.7)+mid*0.38),
                    fbm3(p*detail+vec2(t*0.5,0.0)-mid*0.28));
        float f=fbm3(p*detail+q*(1.55+bass*0.25)+vec2(t*0.25,-t*0.18));

        vec3 deep=vec3(0.04,0.06,0.14);
        vec3 plum=vec3(0.26,0.13,0.30);
        vec3 rose=vec3(0.72,0.34,0.42);
        vec3 amber=vec3(0.94,0.64,0.34);
        vec3 cream=vec3(1.00,0.90,0.74);

        vec3 col=mix(deep,plum,smoothstep(0.25,0.55,f));
        col=mix(col,rose,smoothstep(0.55,0.80,f+mid*0.25));
        col=mix(col,amber,smoothstep(0.65,0.95,f)*(0.5+0.5*q.x));

        vec3 accent=hsv2rgb(vec3(uHueShift/360.0,0.45,0.9));
        col=mix(col,accent,smoothstep(0.55,0.9,q.y)*0.35);

        col+=cream*pow(max(0.0,f-0.55),2.0)*(0.6+bass*1.5);

        col*=1.0-smoothstep(0.81,4.0,dot(p,p))*0.55;
        col*=uIntensity*(0.55+bass*0.20);
        
        float energy = bass * 0.5 + mid * 0.3 + high * 0.2;
        float flash = smoothstep(0.4, 1.2, energy) * 0.6; 
        col *= 1.0 + flash; 

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state) => {
    const b = readBands(getFreqData(), bandsScratch)
    const { sensitivity, hueShift, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uTreble.value = b.treble
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function AuroraSilkPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  // running per-band peaks for auto-gain (bass, mid, treble)
  const peaks = useRef(new Float64Array(3).fill(0.02))
  // Scratch buffers reused every frame — the envelope follower below must
  // not allocate (it used to build 3 throwaway arrays per frame at 60fps).
  const bandsScratch = useMemo(() => ({ bass: 0, mid: 0, treble: 0 }), [])
  const work = useMemo(() => ({
    raw: new Float64Array(3),
    norm: new Float64Array(3),
    target: new Float64Array(3),
  }), [])

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uHueShift: { value: 200 }, uIntensity: { value: 1.5 }, uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBass,uMid,uTreble,uHueShift,uIntensity,uComplexity,uAspect;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0., a=0.5;
        for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.03+vec2(13.7,-7.1); a*=0.5; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;

        // === PROCESSED BANDS: smoothed, auto-gained, 0..1 ===
        // pow(x, 2.2): quiet audio stays dim, only genuine peaks open up
        float bass=pow(clamp(uBass,0.0,1.0),2.2);
        float mid =pow(clamp(uMid, 0.0,1.0),2.2);
        float high=pow(clamp(uTreble,0.0,1.0),2.2);

        float r0=length(p);
        float a=atan(p.y,p.x);

        float ang=a+uTime*0.12+0.7/(r0+0.35);
        vec2 dir=vec2(cos(ang),sin(ang));
        vec2 q=dir*r0;

        float detail=2.0+uComplexity*1.2;

        // BLOOMY SMOKE THRESHOLD (expands on bass — now much harder to fully open)
        float lowThreshold = 0.42 - bass * 0.34;
        vec2 w=vec2(fbm(q*detail*vec2(1.0,1.7)+vec2(0.0,uTime*0.22)),
                    fbm(q*detail*vec2(1.7,1.0)+vec2(uTime*0.18,0.0)));
        float smoke=fbm(q*detail+w*2.0+vec2(-uTime*0.10,uTime*0.08));
        smoke = smoothstep(lowThreshold, 0.9, smoke);

        float rings=sin(r0*(7.0+uComplexity*3.0)-uTime*0.5+smoke*3.5)*0.5+0.5;
        rings=pow(rings,1.6);

        float ridge=1.0-abs(2.0*fbm(q*detail*1.8+w*3.0+vec2(uTime*0.12))-1.0);

        // BASS controls thickness, TREBLE controls brightness
        float thick = 1.0 + bass * 0.8;
        float brightness = 1.0 + high * 2.0;
        brightness = min(brightness, 3.0);

        ridge = pow(ridge, thick);
        ridge *= brightness;

        // === LINE GATING: lines only render when the mid band has real energy ===
        float vis = smoothstep(0.03, 0.55, mid);
        float lineGlow = min(ridge * smoke, 2.5) * vis;

        float flare=pow(clamp((smoke-0.35)/0.65,0.0,1.0),2.0);
        float body=smoke*0.55+rings*smoke*0.85+flare*0.45;

        // ============================================
        // BIOLUMINESCENT PALETTE
        // ============================================
        vec3 colBass = hsv2rgb(vec3(0.72, 0.85, 0.35));
        vec3 colMid  = hsv2rgb(vec3(0.28, 0.75, 0.95));
        vec3 colHigh = hsv2rgb(vec3(0.90, 0.60, 1.3)); // >1.0 for HDR bloom

        float totalEnergy = bass + mid + high + 0.01;
        vec3 activeColor = (colBass * bass + colMid * mid + colHigh * high) / totalEnergy;

        float h0 = uHueShift / 360.0;
        vec3 bg = hsv2rgb(vec3(h0 + 0.60, 0.90, 0.06));

        vec3 col = bg;

        col = mix(col, activeColor * 0.4, smoothstep(0.2, 0.8, body));
        col = mix(col, activeColor * 0.7, smoothstep(0.6, 0.95, body));

        col += activeColor * flare * (0.3 + totalEnergy * 1.2);

        col += activeColor * lineGlow * (0.6 + bass * 0.5);
        // white-hot flash now needs strong treble, not just any audio
        col += vec3(1.0, 1.0, 1.0) * lineGlow * (0.1 + high * high * 1.4);

        // global flush: threshold raised, so it only fires on true peaks
        float globalFlash = smoothstep(1.4, 2.4, totalEnergy) * 0.3;
        col += activeColor * globalFlash;

        col *= 1.0 - smoothstep(1.2, 2.2, length(p)) * 0.6;
        col *= uIntensity * 0.9;
        col = col / (1.0 + col * 0.7);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const b = readBands(getFreqData(), bandsScratch)
    const { sensitivity, hueShift, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height

    // 1) auto-gain per band — bass no longer drowns mid/treble
    const { raw, norm, target } = work
    raw[0] = b.bass; raw[1] = b.mid; raw[2] = b.treble
    const pk = peaks.current
    for (let i = 0; i < 3; i++) {
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.25, raw[i], 0.02)
      norm[i] = Math.min(raw[i] / pk[i], 1)
    }

    // 2) sensitivity as pre-gain, clamped to 0..1
    // 3) envelope follower: fast attack (~60ms), musical release (~250ms)
    for (let i = 0; i < 3; i++) {
      target[i] = Math.pow(Math.min(norm[i] * sensitivity, 1), 1.6)
      const key = BAND_UNIFORMS[i]
      const cur = u[key].value as number
      const k = target[i] > cur
        ? 1 - Math.exp(-dt * 16)
        : 1 - Math.exp(-dt * 4)
      u[key].value = cur + (target[i] - cur) * k
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function Mellow1Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const bandsScratch = useMemo(() => ({ bass: 0, mid: 0, treble: 0 }), [])
  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBass,uMid,uTreble,uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;

      float hash(vec2 p){
        vec3 p3=fract(vec3(p.xyx)*0.1031);
        p3+=dot(p3,p3.yzx+33.33);
        return fract((p3.x+p3.y)*p3.z);
      }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      // MORE OCTAVES (6 instead of 4) = ultra-smooth liquid gradients
      float fbm6(vec2 p){
        float v=0., a=0.55;
        for(int i=0;i<6;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.52; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        float bass=min(uBass*uSensitivity,1.5);
        float mid=min(uMid*uSensitivity,1.5);
        float high=min(uTreble*uSensitivity,1.5);

        // SLOWER time = more flowing, less jittery
        float t=uTime*0.07;

        // Higher detail base = finer, silkier texture
        float detail=2.0+uComplexity*0.8;

        // FIRST WARP: VOCALS (mids) drive the flow, bass is just a gentle breath
        vec2 q=vec2(fbm6(p*detail+vec2(0.0,t*0.5)+mid*0.45),
                    fbm6(p*detail+vec2(t*0.4,0.0)-mid*0.35));

        // SECOND WARP: warp the warp = that liquid-mercury folding effect
        vec2 r=vec2(fbm6(p*detail*0.8+q*1.8+vec2(t*0.3,-t*0.2)),
                    fbm6(p*detail*0.8+q*1.8-vec2(t*0.2,t*0.25)));

        // Final field: bass gently expands, but mostly it's the double-warp flow
        float f=fbm6(p*detail+r*1.6+vec2(t*0.15,-t*0.12)+bass*0.10);

        // SMOOTHER PALETTE: added "silk" tone between plum and rose for fluid gradients
        vec3 deep=vec3(0.04,0.06,0.14);
        vec3 plum=vec3(0.26,0.13,0.30);
        vec3 silk=vec3(0.52,0.28,0.42);   // NEW: liquid transition tone
        vec3 rose=vec3(0.72,0.34,0.42);
        vec3 amber=vec3(0.94,0.64,0.34);
        vec3 cream=vec3(1.00,0.90,0.74);

        // WIDER SMOOTHSTEPS = softer, more fluid color transitions
        vec3 col=mix(deep,plum,smoothstep(0.15,0.60,f));
        col=mix(col,silk,smoothstep(0.35,0.65,f+mid*0.15));
        col=mix(col,rose,smoothstep(0.50,0.85,f+mid*0.20));
        col=mix(col,amber,smoothstep(0.65,0.95,f)*(0.5+0.5*q.x));

        vec3 accent=hsv2rgb(vec3(uHueShift/360.0,0.50,0.92));
        col=mix(col,accent,smoothstep(0.55,0.9,q.y)*0.40);

        // SOFTER HIGHLIGHTS: linear gradient instead of pow = more liquid, less puffy
        col+=cream*max(0.0,f-0.60)*1.5*(0.5+bass*1.0);
        col+=cream*max(0.0,r.x-0.55)*0.8*(0.4+high*0.8);

        // Softer vignette, more fluid edges
        col*=1.0-smoothstep(0.9,4.5,dot(p,p))*0.50;
        col*=uIntensity*(0.60+bass*0.15);

        // SOFTER FLASH: wider range, less punchy, more like a wave
        float energy = bass * 0.4 + mid * 0.4 + high * 0.2;
        float flash = smoothstep(0.3, 1.4, energy) * 0.45;
        col *= 1.0 + flash;

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state) => {
    const b = readBands(getFreqData(), bandsScratch)
    const { sensitivity, hueShift, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uTreble.value = b.treble
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function PrismaticTempestPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.02))
  const rawBands = useMemo(() => new Array<number>(7).fill(0), [])

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;

      float hash(vec2 p){
        vec3 p3=fract(vec3(p.xyx)*0.1031);
        p3+=dot(p3,p3.yzx+33.33);
        return fract((p3.x+p3.y)*p3.z);
      }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0., a=0.5;
        for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.5; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        // === 7 PROCESSED BANDS: smoothed, auto-gained, 0..1 ===
        float e[7];
        for(int i=0;i<7;i++){ e[i]=pow(clamp(uBands[i],0.0,1.0),2.2); }

        // aggregate into bass / mid / high for the swirl behavior
        float bass=(e[0]+e[1])*0.5;
        float mid =(e[2]+e[3]+e[4])/3.0;
        float high=(e[5]+e[6])*0.5;

        float t=uTime*0.12;
        float detail=1.8+uComplexity*0.9;

        // liquid flow field (double domain warp)
        vec2 q=vec2(fbm(p*detail+vec2(0.0,t*0.8)+mid*0.3),
                    fbm(p*detail+vec2(t*0.6,0.0)-mid*0.25));
        vec2 r=vec2(fbm(p*detail+q*2.0+vec2(t*0.5,-t*0.4)),
                    fbm(p*detail+q*2.0-vec2(t*0.35,t*0.45)));
        float f=fbm(p*detail+r*(1.8+bass*0.6));

        // LASER THREADS: razor-thin ridged lines
        float th1=1.0-abs(2.0*f-1.0);
        th1=pow(th1,8.0);
        // second crossing family
        float f2=fbm(p*detail*1.4+r*2.2+vec2(-t*0.6,t*0.5)+3.7);
        float th2=1.0-abs(2.0*f2-1.0);
        th2=pow(th2,10.0);

        // rainbow hue flowing along the beams
        float hue=fract(uHueShift/360.0+f*0.6+t*0.10);
        vec3 laser1=hsv2rgb(vec3(hue,0.90,1.0));
        vec3 laser2=hsv2rgb(vec3(fract(hue+0.33),0.90,1.0));

        // energy gates: brightness/glow now earned, not defaulted
        float vis=smoothstep(0.02,0.45,mid+bass*0.5);
        float flash=1.0+high*2.0;      // treble = brightness snap
        float glow =1.0+bass*1.2;      // bass = bloom swell

        vec3 col=vec3(0.010,0.010,0.030);

        // soft bloom halo around threads
        col+=laser1*pow(th1,0.5)*0.25*glow;
        col+=laser2*pow(th2,0.5)*0.20*glow;
        // bright cores
        col+=laser1*th1*(0.25+mid*1.6)*vis;
        col+=laser2*th2*(0.20+mid*1.4)*vis;
        // white-hot centers: needs a real treble slam (high^2)
        col+=vec3(1.0)*th1*th1*high*high*1.4;

        col*=1.0-smoothstep(1.3,2.4,length(p))*0.5;
        col*=uIntensity*0.9;
        col=col/(1.0+col*0.7);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const bands = readBands7(getFreqData(), rawBands)
    const { sensitivity, hueShift, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height

    const arr = u.uBands.value as number[]
    const pk = peaks.current

    // 1) auto-gain per band
    for (let i = 0; i < 7; i++) {
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.25, bands[i], 0.02)
      const norm = Math.min(bands[i] / pk[i], 1)

      // 2) sensitivity as pre-gain, clamped 0..1
      const target = Math.pow(Math.min(norm * sensitivity, 1), 1.6)

      // 3) envelope follower: fast attack, musical release
      const k = target > arr[i]
        ? 1 - Math.exp(-dt * 16)
        : 1 - Math.exp(-dt * 4)
      arr[i] += (target - arr[i]) * k
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

// 7 log-spread engine bands (of 32, 20Hz-20kHz) feeding SandsOfTime
// lines: ~23Hz, 59Hz, 140Hz, 331Hz, 785Hz, 2.3kHz, 10.5kHz.
const SAND_BAND_PICKS = [1, 5, 9, 13, 17, 22, 29]

function SandsOfTimePreset() {
  const viewport = useThree((state) => state.viewport)
  // Calm timepiece: flow / crawl / t are INTEGRATED (never scaled off
  // the wall clock) so changing `speed` can't jump the phase. All audio
  // uniforms stay frozen — nothing reacts, composition drifts on clocks.
  const st = useRef({ flow: 0, crawl: 0, t: 0, eb: [0, 0, 0, 0, 0, 0, 0] })

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uEnergy: { value: 0 }, uBass: { value: 0 },
      uMid: { value: 0 }, uHigh: { value: 0 }, uKick: { value: 0 }, uBeat: { value: 0 },
      uFlow: { value: 0 }, uCrawl: { value: 0 },
      uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uEnergy,uBass,uMid,uHigh,uKick,uBeat,uFlow,uCrawl,uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;
      uniform float uBands[7];

      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      // Oblique topographic flow field: layered sine warp over
      // log-distance attractors -> nested elliptical contour loops.
      float smoothField(vec2 p, float t){
        vec2 q = p;
        // large slow warp (diagonal drift) — bass sways width ±15%
        float sway = 1.0 + pow(clamp(uBass, 0.0, 1.0), 2.2) * 0.15;
        q += 0.34 * sway * vec2(sin(p.y*1.15 + t*0.90),       sin(p.x*1.05 - t*0.70));
        // secondary meander
        q += 0.14 * sway * vec2(sin(p.y*2.30 - t*0.50 + 1.7), sin(p.x*2.05 + t*0.45));
        // fine ripple keeps lines organic, still smooth (no FBM jitter)
        q += 0.06 * vec2(sin(p.y*4.10 + t*0.35 + 4.2), sin(p.x*3.85 - t*0.30));
        // ocean swell: two low-freq directional traveling waves, coherent roll
        vec2 swellDir = vec2(0.834, 0.552);
        vec2 swellNrm = vec2(-swellDir.y, swellDir.x);
        float sw1 = sin(dot(p, swellDir)*1.40 + t*1.10);
        float sw2 = sin(dot(p, swellDir)*2.30 - t*0.80 + dot(p, swellNrm)*1.10);
        q += swellDir * (sw1*0.18 + sw2*0.09);

        float field = 0.0;
        vec2 d;

        // vortex centers spread across a middle band (world space)
        d = q - vec2(-1.90, -0.15); field += 0.80 * log(dot(d,d) + 0.060);
        d = q - vec2(-0.90,  0.45); field += 0.60 * log(dot(d,d) + 0.075);
        d = q - vec2( 0.05,  0.25); field += 0.70 * log(dot(d,d) + 0.065);
        d = q - vec2( 1.55,  0.45); field += 0.85 * log(dot(d,d) + 0.055);
        d = q - vec2( 1.15, -0.35); field += 0.70 * log(dot(d,d) + 0.070);
        d = q - vec2(-0.35, -0.85); field += 0.55 * log(dot(d,d) + 0.090);
        d = q - vec2( 0.55, -1.15); field += 0.45 * log(dot(d,d) + 0.100);
        d = q - vec2(-1.10, -0.85); field += 0.50 * log(dot(d,d) + 0.110);
        d = q - vec2(-1.55, -0.55); field += 0.50 * log(dot(d,d) + 0.075);
        d = q - vec2(-0.70, -1.25); field += 0.45 * log(dot(d,d) + 0.080);
        // extra bottom-left loops: offset centers interleave with the
        // big-circle nest instead of stacking on it
        d = q - vec2(-1.30, -0.28); field += 0.45 * log(dot(d,d) + 0.085);
        d = q - vec2(-0.45, -1.08); field += 0.45 * log(dot(d,d) + 0.090);

        // gentle global drift
        field += 0.14 * q.x + 0.08 * q.y;
        field += 0.05 * sin(q.x*1.2 + q.y*0.8 + t*0.2);

        return field;
      }

      float hash21(vec2 p){
        p = fract(p*vec2(234.34,435.345));
        p += dot(p, p+34.23);
        return fract(p.x*p.y);
      }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        float a = hash21(i), b = hash21(i+vec2(1.0,0.0));
        float c = hash21(i+vec2(0.0,1.0)), d = hash21(i+vec2(1.0,1.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      float fbm2(vec2 p){
        float v = 0.0, a = 0.5;
        for(int i=0;i<3;i++){ v += a*vnoise(p); p = p*2.03 + vec2(17.3,-9.1); a *= 0.5; }
        return v;
      }

      // Streak line: wobbled phase (local direction change) + per-pixel
      // width (thin/thick) + segment mask (disconnected dashes).
      // Returns vec2(line, brightness).
      vec2 streakLine(float field, float scale, float baseWidth,
                      float wobble, float segM, float brightM){
        float phase = field*scale + wobble;
        float dist = abs(fract(phase)-0.5);
        float aa = max(fwidth(phase), 0.001);
        float w = max(baseWidth, 0.002);
        // soft shoulders: full core, eased falloff (no hard edge shimmer)
        float line = 1.0 - smoothstep(w*0.7, w + aa*2.0, dist);
        // soft dash ends so segments stay disconnected
        float seg = smoothstep(0.30, 0.52, segM) * (1.0 - smoothstep(0.78, 0.98, segM)*0.85);
        return vec2(line*seg, brightM);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        // diagonal composition angle (~-22deg): flow runs bottom-left to top-right
        float ang = -0.38;
        float ca = cos(ang), sa = sin(ang);
        p = mat2(ca,-sa,sa,ca) * p;

        // oblique viewing tilt: top of screen recedes -> world coords spread + fade
        float persp = max(1.0 - p.y*0.52, 0.32);
        vec2 w = p / persp;
        w.y -= 0.12;

        float bass=pow(clamp(uBass,0.0,1.0),2.2);
        float mid =pow(clamp(uMid, 0.0,1.0),2.2);
        float high=pow(clamp(uHigh,0.0,1.0),2.2);

        // per-line Hz: engine bands arrive normalized + enveloped.
        // contour id -> band; silent band = dim ghost (0.1), never gone.
        float e[7];
        for(int i=0;i<7;i++){ e[i]=pow(clamp(uBands[i],0.0,1.0),2.2); }

        // bass pushes outward instead of flashing: displace the sample point
        // radially, so lines shove away from center on heavy lows
        vec2 pushDir = w / max(length(w), 0.001);
        float push = bass * 0.10 + uKick * 0.05;

        // flow breathes with overall energy; kick adds a small swell
        // uFlow is integrated JS-side: scaling a rate never jumps the phase
        float t = uFlow;

        float field = smoothField(w + pushDir * push, t);

        // energy breathes width/brightness a little; bass no longer flashes,
        // it pushes (see push above) instead
        float audio   = clamp(uEnergy, 0.0, 1.0)*0.6 + mid*0.15;
        float breathe = 1.0 + audio*0.15 + sin(uTime*0.45)*0.025;

        float baseWidth = 0.012 + audio*0.002;
        float scale = 7.5 + uComplexity*0.70;

        // flow-following sample coords: noise advected along the field
        // so width / brightness / gaps vary per streak, not per contour
        vec2 fp = w*1.6;
        // ocean undulation rides on fbm wobble: coherent traveling wave
        // along swell dir so whole lines roll, not just jitter locally
        float swellWob = sin(dot(fp, vec2(0.834, 0.552))*1.8 + t*1.2)*0.35 + sin(dot(fp, vec2(-0.552, 0.834))*2.2 - t*0.9)*0.20;
        float wob1 = (fbm2(fp*2.1 + vec2(t*0.35, -t*0.28) + field*0.9)-0.5)*3.0 + swellWob;
        float wob2 = (fbm2(fp*4.3 - vec2(t*0.22, t*0.30) + field*1.7)-0.5)*2.2 + swellWob*0.7;
        float thickN  = fbm2(fp*2.3 + 7.3 - field*0.5 + t*0.10);
        float brightN = fbm2(fp*1.3 + 3.1 + vec2(field*0.9, -field*0.6) - t*0.12);
        float segN1 = fbm2(fp*1.8 + vec2(t*0.25 + uCrawl, -t*0.20) + field*0.7);
        float segN2 = fbm2(fp*3.7 - vec2(t*0.18, t*0.22) + field*1.3);

        // per-streak width: some hairline thin, some thick
        float widthVar = mix(0.45, 2.30, thickN);
        float widthVarFine = mix(0.40, 1.80, fract(thickN*7.0));
        // per-streak brightness: some dim ghosts, some hot
        float bright1 = 0.22 + 1.65*pow(brightN, 1.6);
        float bright2 = 0.20 + 1.40*pow(fract(brightN*5.0), 1.4);

        // raspy sand erosion: high-frequency noise advected by the field
        // chews the line edges so they read sandy, not vector-smooth
        float raspN = vnoise(fp*70.0 + vec2(field*9.0, -field*7.0) + vec2(0.0, t*0.6));
        float sandN = vnoise(fp*180.0 - vec2(field*11.0, field*5.0));
        float raspMask = mix(0.40, 1.0, smoothstep(0.20, 0.80, raspN*0.65 + sandN*0.35 + 0.15));

        // two crossing systems: broad slow streaks + fine fast ones,
        // each with own wobble/segment/noise -> different local directions
        // gold-only: single field sample per system, no chromatic offsets
        vec2 s1c = streakLine(field, scale, baseWidth*widthVar, wob1, segN1, bright1);
        vec2 s2 = streakLine(field*1.02 + 0.31, scale*2.0, baseWidth*widthVarFine*0.55, wob2, segN2, bright2);

        // each line its own band (id from field, +3 offset so systems
        // never share). 0.1 floor: quiet lines ghost, audio lifts to full.
        float eb1 = e[int(mod(floor(field*scale), 7.0))];
        float eb2 = e[int(mod(floor((field*1.02 + 0.31)*scale*2.0) + 3.0, 7.0))];
        float g1 = 0.1 + 0.9*smoothstep(0.02, 0.35, eb1);
        float g2 = 0.1 + 0.9*smoothstep(0.02, 0.35, eb2);
        s1c *= g1;
        s2 *= g2;

        float lg = max(s1c.x, s2.x*0.50);
        lg *= raspMask;
        float bright = max(s1c.y, s2.y*0.8);

        // fixed champagne-gold, no hue drift, no rainbow fringe.
        // peaks nudge toward white-hot instead of new hues.
        float shade = 0.5 + 0.5*sin(field*2.2 + w.x*0.8 + w.y*0.6 + t*0.4);
        vec3 goldCore = vec3(1.00, 0.83, 0.60);
        vec3 goldMid  = vec3(0.78, 0.55, 0.32);
        vec3 ridge = mix(goldMid, goldCore, shade);

        // warm near-black base
        vec3 col = vec3(0.020, 0.016, 0.012);

        // no fog: flat response, no top fade / vignette / center glow.
        float strength = 0.9 * breathe * bright;

        col += ridge * lg * strength;

        // light flowing inside the lines: diagonal wave on the integrated
        // flow clock, masked to lines. Per-line variation rides free on lg.
        float flowLight = pow(0.5 + 0.5*sin(dot(w, vec2(0.83, 0.55))*6.0 - uFlow*8.0 + field*3.0), 4.0);
        col += vec3(1.0, 0.90, 0.68) * flowLight * lg * 0.9;

        // shiny sand: tight crest highlight + sparse hot grains stuck to lines
        col += vec3(1.0,0.95,0.85) * pow(lg,3.0) * (0.12 + high*0.35) * breathe * (0.4 + bright);
        float cell = hash21(floor(w*230.0) + floor(field*14.0));
        col += vec3(1.0,0.90,0.70) * step(0.978, cell) * lg * 0.9;
        col += vec3(1.0,0.88,0.66) * pow(sandN, 9.0) * lg * 2.2;

        // light film tooth so blacks stay sandy, not milky
        float g = fract(sin(dot(vUv*vec2(1243.0,1179.0)+mod(uTime,10.0), vec2(12.9898,78.233)))*43758.5453);
        col += (g-0.5)*0.035;

        col *= uIntensity*0.9;
        col = col/(1.0+col*0.6);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  // a hand-built material is not owned by R3F, so dispose it ourselves
  useEffect(() => () => material.dispose(), [material])

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.05)
    const a = getAnalysis()
    const { sensitivity, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = material.uniforms
    const s = st.current

    // per-line Hz feed: engine bands are already normalized + enveloped.
    // JS follower (attack 6 / release 2.5, frame-rate independent) takes
    // the snap off: attacks soften, decays trail smoothly.
    const arr = u.uBands.value as number[]
    const eb = s.eb
    for (let i = 0; i < 7; i++) {
      const target = Math.min(a.bands[SAND_BAND_PICKS[i]] * sensitivity, 1)
      const rate = target > eb[i] ? 6 : 2.5
      eb[i] += (target - eb[i]) * (1 - Math.exp(-dt * rate))
      arr[i] = eb[i]
    }

    // integrated clocks: constant rate, phase never jumps.
    s.flow  += dt * speed * 0.06
    s.crawl += dt * 0.035
    s.t     += dt * speed

    u.uTime.value = s.t
    u.uEnergy.value = 0.55
    u.uBass.value = 0.45
    u.uMid.value = 0.5
    u.uHigh.value = 0.5
    u.uKick.value = 0
    u.uBeat.value = 0
    u.uFlow.value = s.flow
    u.uCrawl.value = s.crawl
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height
  })

  return (
    <mesh material={material}>
      <planeGeometry args={[viewport.width, viewport.height]} />
    </mesh>
  )
}

function AcidWashPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  // running per-band peak for auto-gain (adapts to any input level)
  const peaks = useRef(new Float64Array(7).fill(0.02))
  const rawBands = useMemo(() => new Array<number>(7).fill(0), [])

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;

      float hash(vec2 p){
        vec3 p3=fract(vec3(p.xyx)*0.1031);
        p3+=dot(p3,p3.yzx+33.33);
        return fract((p3.x+p3.y)*p3.z);
      }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0., a=0.5;
        for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.5; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        float t=uTime*0.12;
        float detail=1.8+uComplexity*0.9;

        vec2 q=vec2(fbm(p*detail+vec2(0.0,t*0.8)),
                    fbm(p*detail+vec2(t*0.6,0.0)));
        vec2 r=vec2(fbm(p*detail+q*2.0+vec2(t*0.5,-t*0.4)),
                    fbm(p*detail+q*2.0-vec2(t*0.35,t*0.45)));
        float f=fbm(p*detail+r*1.8);

        float hs=uHueShift/360.0-0.5556;
        float hues[7];
        hues[0]=0.99; hues[1]=0.05; hues[2]=0.85; hues[3]=0.72;
        hues[4]=0.58; hues[5]=0.45; hues[6]=0.30;

        vec3 col=vec3(0.010,0.010,0.030);
        col+=vec3(0.05,0.04,0.10)*f*0.25;

        for(int i=0;i<7;i++){
          float fi=float(i);
          float lvl=0.12+fi*0.115+0.04*sin(uTime*0.35+fi*1.7);
          float d=f-lvl;
          float sharp=140.0+fi*45.0;
          float line=exp(-d*d*sharp);

          // uBands arrives smoothed + auto-gained in 0..1
          // pow(e, 2.2): quiet audio stays dim, only real peaks open up
          float e=pow(clamp(uBands[i],0.0,1.0),2.2);

          // line only exists when the band has energy — no more always-on silk
          float vis=smoothstep(0.03,0.55,e);
          line*=vis;

          vec3 bc=hsv2rgb(vec3(fract(hues[i]+hs),0.90,1.0));

          col+=bc*pow(line,0.6)*0.15*e;        // halo, tied to energy
          col+=bc*line*(0.05+e*1.35);          // core: idle 0.05, full ~1.4
          col+=vec3(1.0)*line*e*e*e*0.60;      // white-hot needs e≈0.8+
        }

        col*=1.0-smoothstep(1.3,2.4,length(p))*0.5;
        col*=uIntensity*0.9;
        col=col/(1.0+col*0.9);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const bands = readVisualBands(getAnalysis(), rawBands)
    const { sensitivity, hueShift, intensity, speed, complexity } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height

    const arr = u.uBands.value as number[]
    const pk = peaks.current

    for (let i = 0; i < 7; i++) {
      // 1) auto-gain: track a slow-decaying peak per band so bass vs treble
      //    get equalized regardless of input loudness
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.25, bands[i], 0.02)
      const norm = Math.min(bands[i] / pk[i], 1)          // 0..1

      // 2) sensitivity as pre-gain, clamped
      const target = Math.pow(Math.min(norm * sensitivity, 1), 1.6)

      // 3) envelope follower: snappy attack (~60ms), musical release (~250ms)
      const k = target > arr[i]
        ? 1 - Math.exp(-dt * 16)
        : 1 - Math.exp(-dt * 4)
      arr[i] += (target - arr[i]) * k
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}
function ChromaticBurstPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.05))
  const rawBands = useMemo(() => new Array<number>(7).fill(0), [])
  const vocal = useRef(0)

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uHueShift: { value: 200 }, uIntensity: { value: 1.5 }, uAspect: { value: 1 },
      uLineCount: { value: 60.0 },
      uPushStrength: { value: 0.8 },
      uWaveSpeed: { value: 1.8 },      
      uTaper: { value: 0.1 },          
      uCoreSize: { value: 16.0 },       
      uRotationSpeed: { value: 0.2 },  
      uZoom: { value: 2.0 },           // 1.0 = normal, 2.0 = zoomed in 2x
      uVocal: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uHueShift,uIntensity,uAspect,uLineCount,uPushStrength,uWaveSpeed,uTaper,uCoreSize,uRotationSpeed,uZoom,uVocal;

      vec3 hsv(vec3 c){vec4 k=vec4(1.,.666666,.333333,3.);vec3 p=abs(fract(c.xxx+k.xyz)*6.-k.www);return c.z*mix(k.xxx,clamp(p-k.xxx,0.,1.),c.y);}
      float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
      float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
      float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*vnoise(p);p=p*2.03+vec2(9.2,-5.4);a*=.5;}return v;}

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;
        
        // ZOOM APPLIED HERE
        p /= uZoom;

        float e[7];
        float strongest=0.0;
        for(int i=0;i<7;i++){
          e[i]=pow(clamp(uBands[i],0.0,1.0),1.6);
          strongest=max(strongest,e[i]);
        }
        float bass=(e[0]+e[1])*0.5;
        float mid =(e[2]+e[3]+e[4])/3.0;
        float high=(e[5]+e[6])*0.5;

        float audio=smoothstep(0.01,0.30,strongest);

        float r=length(p);
        float a=atan(p.y,p.x);
        float t=uTime;

        float hs=uHueShift/360.0;
        float hues[7];
        hues[0]=0.97; hues[1]=0.05; hues[2]=0.13; hues[3]=0.30;
        hues[4]=0.45; hues[5]=0.60; hues[6]=0.78;

        vec3 col=vec3(0.00,0.000,0.00);

        for(int layer=0;layer<3;layer++){
          float lf=float(layer);
          
          float rot=t*(0.3+lf*0.15)*uRotationSpeed+lf*0.5+mid*0.05*uRotationSpeed;
          float angle=a+rot;
          
          float lineIdx=floor((angle+3.14159)/(6.28318/uLineCount));
          float bandIdx=mod(lineIdx,7.0);
          int bi=int(bandIdx);
          float eb=e[bi];

          float lineAngle=(lineIdx+0.5)*(6.28318/uLineCount)-3.14159-rot;
          float distFromLine=abs(mod(a-lineAngle+3.14159,6.28318)-3.14159);
          
          float baseWidth=0.012+lf*0.008;
          float taper=1.0-r*uTaper;
          float lineMask=smoothstep(baseWidth*taper,0.0,distFromLine);

          float baseLength=0.25+lf*0.15;
          float pushLength=(baseLength+eb*0.8*uPushStrength)*audio;
          float lengthMask=smoothstep(pushLength,pushLength-0.1,r);

          float line=lineMask*lengthMask;
          
          float wave=sin(r*20.0-t*4.0*uWaveSpeed+lineIdx*0.8)*0.5+0.5;
          wave=pow(wave,2.0);
          line*=0.7+wave*0.3;

          float gate=smoothstep(0.05,0.50,eb)*audio;
          float glow=line*gate;
          // voice-band rays (visual bands 2-4 ~= 175Hz-3kHz) lift with vocal presence
          float voiceBand=(bi==2||bi==3||bi==4)?1.0:0.0;
          glow*=1.0+uVocal*voiceBand*1.2;

          vec3 lc=hsv(vec3(fract(hues[bi]+hs),0.85,1.0));
          
          float layerBright=1.0-lf*0.3;
          col+=lc*glow*uIntensity*layerBright;
        }

        col*=1.0-smoothstep(1.2,2.2,r)*0.6;
        col=col/(1.0+col*0.7);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    // 7-band contour comes from the shared analysis engine (32 log bands,
    // adaptively normalized) instead of re-deriving bands from raw FFT bytes.
    const analysis = getAnalysis()
    const bands = readVisualBands(analysis, rawBands)
    const { hueShift, intensity, speed } = presetParamsFor(useStore.getState())
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uAspect.value = viewport.width / viewport.height

    const arr = u.uBands.value as number[]
    const pk = peaks.current
    const HEADROOM = 1.6
    vocal.current += (Math.min(analysis.vocalPresence, 1) - vocal.current) * (1 - Math.exp(-dt * 6))
    u.uVocal.value = vocal.current

    for (let i = 0; i < 7; i++) {
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.15, bands[i], 0.05)
      const norm = Math.min(bands[i] / (pk[i] * HEADROOM), 1)
      const target = Math.pow(norm, 1.5)
      const k = target > arr[i]
        ? 1 - Math.exp(-dt * 12)
        : 1 - Math.exp(-dt * 4)
      arr[i] += (target - arr[i]) * k
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

// Waveform width for the time-domain presets. Must match the extension's
// time-domain tap and emberAnalyser.ts' FFT_SIZE (both 2048).
const WAVE_SIZE = 2048

/**
 * Shared waveform source for the time-domain presets (Fractal Ember, AM Preset).
 * Owns the 2048-sample buffer + DataTexture, refills it each frame from the
 * extension tab-capture (when live) or the dedicated local AnalyserNode tap,
 * and releases the tap + texture on unmount.
 * `alpha` is the temporal-smoothing factor: 1 = replace (raw trace),
 * <1 = exponential blend toward the newest samples (calmer, flowing wave).
 */
function useWaveTrace() {
  const tex = useMemo(() => {
    const data = new Uint8Array(WAVE_SIZE).fill(128) // 128 = silence
    const t = new THREE.DataTexture(data, WAVE_SIZE, 1, THREE.RedFormat, THREE.UnsignedByteType)
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.needsUpdate = true
    return t
  }, [])
  const buf = useMemo(() => tex.image.data as Uint8Array, [tex])
  const scratch = useRef(new Uint8Array(WAVE_SIZE))

  useEffect(() => () => {
    teardownEmberWaveAnalyser()
    tex.dispose()
  }, [tex])

  const refresh = useCallback((alpha: number) => {
    const raw = scratch.current
    // Extension tab-capture wins (same precedence as audio.ts): it reflects
    // the actual audible source (Spotify SDK or captured tab audio) even when
    // a stale local AnalyserNode from an earlier file session is still wired
    // into the graph (that tap reads silence once the local file is paused).
    const ext = getExtensionWaveData()
    if (ext) {
      raw.set(ext.subarray(0, WAVE_SIZE))
    } else {
      const waveAnalyser = getEmberWaveAnalyser()
      if (waveAnalyser) waveAnalyser.getByteTimeDomainData(raw)
      else raw.fill(128) // no audio source yet — hold a flat silence line
    }
    if (alpha >= 1) {
      buf.set(raw)
    } else {
      for (let i = 0; i < WAVE_SIZE; i++) buf[i] = buf[i] + (raw[i] - buf[i]) * alpha
    }
    tex.needsUpdate = true
  }, [buf, tex])

  return { tex, refresh }
}

function WaveformPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime, uBass, uAspect;
      uniform sampler2D uWave;   // 0..1, 0.5 = silence

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        p.x *= uAspect;

        float amp = 0.05 + uBass * 0.45;

        // Plot real audio: x position -> sample in the rolling window
        float t  = vUv.x;
        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - 0.002, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + 0.002, 0.5)).r;

        float y = (s - 0.5) * 2.0 * amp;

        // Keep your perpendicular-distance trick (still needed for thick
        // consistent strokes on steep transients like kick drums)
        float dsdt = (sR - sL) / 0.004;
        float dydx = amp * dsdt / uAspect;
        float dist = abs(p.y - y) / sqrt(1.0 + dydx * dydx);

        float thickness = 0.001 + uBass * 0.01;
        float line = 1.0 - smoothstep(thickness - 0.004, thickness, dist);

        gl_FragColor = vec4(vec3(line), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData()) // shared bass/mid/treble bands, unchanged

    refresh(1) // raw time-domain trace → texture

    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = Math.min(b.bass * sensitivity, 1.0)
    u.uAspect.value = viewport.width / viewport.height
  })

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial ref={materialRef} {...shader} />
    </mesh>
  )
}

/**
 * AM Preset — an exact WaveformPreset copy (raw rolling time-domain trace,
 * bass-reactive amplitude + thickness, crisp white stroke) with every magic
 * number lifted into AM_TUNE so each behavior has a code control. Defaults
 * reproduce WaveformPreset 1:1 (follow 1, mirror off, gain 1).
 */
const AM_TUNE = {
  follow: 2,         // refresh blend; 1 = raw sample, exactly like Waveform
  ampQuiet: 0.01,    // amplitude floor at silence
  ampEnergy: 0.55,   // amplitude added at full bass
  thickMin: 0.002,   // stroke width at silence
  thickEnergy: 0.002, // stroke width added at full bass
  spacing: 0.001,    // derivative sampling step (thick-stroke consistency)
  soft: 0.00008,       // smoothstep AA shoulder
  gain: 1,           // master amplitude multiplier
  mirror: true,     // true = symmetric mirror trace, false = Waveform look
}

function AMPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },
      uAmpQuiet: { value: AM_TUNE.ampQuiet },
      uAmpEnergy: { value: AM_TUNE.ampEnergy },
      uGain: { value: AM_TUNE.gain },
      uThickMin: { value: AM_TUNE.thickMin },
      uThickEnergy: { value: AM_TUNE.thickEnergy },
      uSpacing: { value: AM_TUNE.spacing },
      uSoft: { value: AM_TUNE.soft },
      uMirror: { value: AM_TUNE.mirror ? 1 : 0 },
      uFlip: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime, uBass, uAspect;
      uniform float uAmpQuiet, uAmpEnergy, uGain;
      uniform float uThickMin, uThickEnergy;
      uniform float uSpacing, uSoft;
      uniform float uMirror;
      uniform float uFlip;
      uniform sampler2D uWave;   // 0..1, 0.5 = silence

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        p.x *= uAspect;

        float amp = (uAmpQuiet + uBass * uAmpEnergy) * uGain;

        // Plot real audio: x position -> sample in the rolling window
        float t = vUv.x;
        if (uMirror > 0.5) {
          t = abs(vUv.x - 0.5) * 2.0;
        }
        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - uSpacing, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + uSpacing, 0.5)).r;

        float y = (s - 0.5) * 2.0 * amp;

        // Keep the perpendicular-distance trick (still needed for thick
        // consistent strokes on steep transients like kick drums)
        float dsdt = (sR - sL) / (2.0 * uSpacing);
        float dydx = amp * dsdt / uAspect;
        float dist = abs(p.y - y) / sqrt(1.0 + dydx * dydx);

        float thickness = uThickMin + uBass * uThickEnergy;
        float line = 1.0 - smoothstep(thickness - uSoft, thickness, dist);

        // Flip inverts the palette: white stroke on black <-> black stroke on white.
        float shade = mix(line, 1.0 - line, uFlip);
        gl_FragColor = vec4(vec3(shade), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData()) // shared bass/mid/treble bands, unchanged

    refresh(AM_TUNE.follow) // raw time-domain trace → texture

    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = Math.min(b.bass * sensitivity, 1.0)
    u.uAspect.value = viewport.width / viewport.height
    u.uAmpQuiet.value = AM_TUNE.ampQuiet
    u.uAmpEnergy.value = AM_TUNE.ampEnergy
    u.uGain.value = AM_TUNE.gain
    u.uThickMin.value = AM_TUNE.thickMin
    u.uThickEnergy.value = AM_TUNE.thickEnergy
    u.uSpacing.value = AM_TUNE.spacing
    u.uSoft.value = AM_TUNE.soft
    u.uMirror.value = AM_TUNE.mirror ? 1 : 0
    u.uFlip.value = useStore.getState().amFlip ? 1 : 0
  })

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial ref={materialRef} {...shader} />
    </mesh>
  )
}

function AM2Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },

      uAmpQuiet: { value: AM_TUNE.ampQuiet },
      uAmpEnergy: { value: AM_TUNE.ampEnergy },
      uGain: { value: AM_TUNE.gain },

      uThickMin: { value: AM_TUNE.thickMin },
      uThickEnergy: { value: AM_TUNE.thickEnergy },
      uBassGate: { value: 1 },
      uMidGate: { value: 1 },
      uTrebleGate: { value: 1 },
      uSpacing: { value: AM_TUNE.spacing },
      uSoft: { value: AM_TUNE.soft },

      uMirror: { value: AM_TUNE.mirror ? 1 : 0 },
      uFlip: { value: 0 },
    },

    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      varying vec2 vUv;

      uniform float uTime;
      uniform float uBass;
      uniform float uMid;
      uniform float uTreble;
      uniform float uAspect;

      uniform float uAmpQuiet;
      uniform float uAmpEnergy;
      uniform float uGain;

      uniform float uThickMin;
      uniform float uThickEnergy;
      uniform float uBassGate;
      uniform float uMidGate;
      uniform float uTrebleGate;
      uniform float uSpacing;
      uniform float uSoft;

      uniform float uMirror;
      uniform float uFlip;

      uniform sampler2D uWave;

      // Draw one waveform divider inside a local vertical band.
      float drawWave(
        float center,
        float band,
        float bandAmp,
        float thickness
      ) {
        float t = vUv.x;

        if (uMirror > 0.5) {
          t = abs(vUv.x - 0.5) * 2.0;
        }

        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - uSpacing, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + uSpacing, 0.5)).r;

        float y = center + (s - 0.5) * 2.0 * bandAmp;

        float dsdt = (sR - sL) / (2.0 * uSpacing);
        float dydx = bandAmp * dsdt / uAspect;

        float dist = abs(vUv.y - y) / sqrt(1.0 + dydx * dydx);

        return 1.0 - smoothstep(
          thickness - uSoft,
          thickness,
          dist
        );
      }

      void main() {
        // Independent response for each frequency band.
        float bassAmp =
          (uAmpQuiet + uBass * uAmpEnergy)
          * uGain
          * 0.25;

        float midAmp =
          (uAmpQuiet + uMid * uAmpEnergy)
          * uGain
          * 0.75;

        float trebleAmp =
          (uAmpQuiet + uTreble * uAmpEnergy)
          * uGain
          * 0.25;

        // Three horizontal divider positions.
        float bassY = 0.50;
        float midY = 0.50;
        float trebleY = 0.50;

        // Slightly different thickness per band.
        float bassThickness =
          uThickMin + uBass * uThickEnergy;

        float midThickness =
          uThickMin * 0.82 + uMid * uThickEnergy * 0.72;

        float trebleThickness =
          uThickMin * 0.68 + uTreble * uThickEnergy * 0.55;

        float bass = drawWave(
          bassY,
          0.0,
          bassAmp,
          bassThickness
        ) * uBassGate;

        float mid = drawWave(
          midY,
          0.0,
          midAmp,
          midThickness
        ) * uMidGate;

        float treble = drawWave(
          trebleY,
          0.0,
          trebleAmp,
          trebleThickness
        ) * uTrebleGate;

        float line = max(bass, max(mid, treble));

        // Flip: white on black <-> black on white.
        float shade = mix(
          line,
          1.0 - line,
          uFlip
        );

        gl_FragColor = vec4(vec3(shade), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed, bassAmp, midAmp, trebleAmp } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData())

    refresh(AM_TUNE.follow)

    const u = materialRef.current.uniforms

    u.uTime.value = state.clock.elapsedTime * speed

    u.uBass.value =
      Math.min(b.bass * sensitivity * bassAmp, 1.0)

    u.uMid.value =
      Math.min(b.mid * sensitivity * midAmp, 1.0)

    u.uTreble.value =
      Math.min(b.treble * sensitivity * trebleAmp, 1.0)

    // Amp at 0 = band gone entirely (kills the quiet-floor remnant too).
    u.uBassGate.value =
      bassAmp > 0 ? 1 : 0

    u.uMidGate.value =
      midAmp > 0 ? 1 : 0

    u.uTrebleGate.value =
      trebleAmp > 0 ? 1 : 0

    u.uAspect.value =
      viewport.width / viewport.height

    u.uAmpQuiet.value =
      AM_TUNE.ampQuiet

    u.uAmpEnergy.value =
      AM_TUNE.ampEnergy

    u.uGain.value =
      AM_TUNE.gain

    u.uThickMin.value =
      AM_TUNE.thickMin

    u.uThickEnergy.value =
      AM_TUNE.thickEnergy

    u.uSpacing.value =
      AM_TUNE.spacing

    u.uSoft.value =
      AM_TUNE.soft

    u.uMirror.value =
      AM_TUNE.mirror ? 1 : 0

    u.uFlip.value =
      useStore.getState().amFlip ? 1 : 0
  })

  return (
    <mesh>
      <planeGeometry
        args={[viewport.width, viewport.height]}
      />
      <shaderMaterial
        ref={materialRef}
        {...shader}
      />
    </mesh>
  )
}

function useCanvasSource() {
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
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
      const track = spotifyCurrentTrack
      if (!track) return

      try {
        // 🪄 Just fetch your own local path! The proxy handles the rest.
        const res = await fetch(`/api/canvas?trackId=${encodeURIComponent(track.id)}`)
        if (!res.ok) throw new Error('proxy error')
        
        const data = await res.json()
        const canvasUrl = data?.canvasesList?.[0]?.canvasUrl
        if (!canvasUrl) throw new Error('no canvas for this track')
        
        makeVideo(canvasUrl, 9 / 16)
      } catch {
        // Fallback to album art if no canvas exists
        const art = track.album?.images?.[0]?.url
        if (art) makeImage(art)
      }
    })()

    return () => { dead = true; dispose?.() }
  }, [spotifyCurrentTrack?.id])

  return source
}
function CanvasAmbientPreset() {
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

/**
 * Canvas Ambient 2 — calm Apple Music-style gradient. Artwork card shows
 * the album cover directly (no canvas video); the background combines the
 * cover's own vivid palette (a smooth five-stop ramp) with a warped, heavily
 * blurred bleed of the cover itself (makeCoverPreview), so the wash is
 * literally the album's colors and travels with the music's flow field.
 * No audio reactivity by design — the palette lerps toward each new cover
 * (~1.5s) so track changes crossfade instead of cutting.
 */
function CanvasAmbient2Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((s) => s.viewport)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const coverUrl = track?.album?.images?.[0]?.url
  // Cover texture loaded directly (v1 keeps using useCanvasSource), plus the
  // 24px preview + palette behind the ambient wash (see makeCoverPreview).
  const [art, setArt] = useState<{
    tex: THREE.Texture | null
    bleed: THREE.Texture | null
    palette: Rgb[] | null
    aspect: number
  }>({ tex: null, bleed: null, palette: null, aspect: 1 })
  useEffect(() => {
    let dead = false
    let loaded: THREE.Texture | null = null
    let bleedLoaded: THREE.CanvasTexture | null = null
    if (!coverUrl) {
      setArt({ tex: null, bleed: null, palette: null, aspect: 1 })
      return
    }
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
    u.uTex.value = art.tex
    u.uBleedTex.value = art.bleed
    u.uHasTex.value = art.tex ? 1 : 0
    u.uHasBleed.value = art.bleed ? 1 : 0
    u.uArtAspect.value = art.aspect
  }, [art])

  // Palette read off the cover's own pixels; the muted useArtGradient stops
  // belong to the player box, not to a full-screen wash, so this preset runs
  // on its own vivid extraction (falling back while nothing has loaded).
  const targetPalette = art.palette ?? FALLBACK_PALETTE

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
function ActivePreset() {
  const currentPreset = useStore((state) => state.currentPreset)

  switch (currentPreset) {
    case 'amPreset':
      return <AMPreset />
    case 'am2Preset':
      return <AM2Preset />
    case 'auroraSilk':
      return <AuroraSilkPreset />
    case 'brat':
      return null
    case 'canvasAmbient':
      return <CanvasAmbientPreset />
    case 'canvasAmbient2':
      return <CanvasAmbient2Preset />
    case 'chromaticBurst':
      return <ChromaticBurstPreset />
    case 'mellow1':
      return <Mellow1Preset />
    case 'mellow2':
      return <Mellow2Preset />
    case 'prismaticTempest':
      return <PrismaticTempestPreset />
    case 'sandsOfTime':
      return <SandsOfTimePreset />
    case 'acidWash':
      return <AcidWashPreset />
    case 'waveform':
      return <WaveformPreset />
    default:
      return <CanvasAmbientPreset />
  }
}

/**
 * FPS cap for demand-mode rendering. Interval-driven invalidate() requests
 * one frame per tick; R3F renders nothing in between. No-op when unlimited.
 */
function FpsGate({ limit }: { limit: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (limit <= 0) return
    const id = window.setInterval(invalidate, 1000 / limit)
    return () => window.clearInterval(id)
  }, [limit, invalidate])
  return null
}

export default function Scene() {
  const fpsLimit = useStore((s) => s.fpsLimit)
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 55 }}
      dpr={[1, 1.5]}
      frameloop={fpsLimit > 0 ? 'demand' : 'always'}
      gl={{ antialias: false, powerPreference: 'high-performance', depth: false, stencil: false }}
    >
      <FpsGate limit={fpsLimit} />
      <color attach="background" args={['#020308']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[3, 4, 5]} intensity={1.1} />
      <ActivePreset />
    </Canvas>
  )
}