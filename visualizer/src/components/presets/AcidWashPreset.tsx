import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getAnalysis, readVisualBands } from '../../analyser'
import { fract, hsv2rgb, smoothstep } from './glsl'

// The seven contour lines of the acid-wash look. Each line's height, sharpness
// and colour depend only on its index and the current params — the same value
// for every pixel — so they are evaluated once a frame in the component and
// cross the GPU boundary as uniforms. See the loop in the fragment shader.
const LINE_HUES = [0.99, 0.05, 0.85, 0.72, 0.58, 0.45, 0.30]
const LINE_COUNT = LINE_HUES.length

export default function AcidWashPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  // running per-band peak for auto-gain (adapts to any input level)
  const peaks = useRef(new Float64Array(7).fill(0.02))
  const rawBands = useMemo(() => new Array<number>(7).fill(0), [])
  // The envelope-follower output, which the shader no longer needs to see: it
  // only reads the processed per-line values derived from it.
  const envelope = useRef(new Float64Array(7))

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uSensitivity: { value: 1 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
      // Per-line values for the current frame; see the fragment shader's loop.
      // uLineCol is vec3[7] flattened, which is the shape three uploads.
      uLineLvl: { value: new Array(LINE_COUNT).fill(0) },
      uLineSharp: { value: new Array(LINE_COUNT).fill(0) },
      uLineE: { value: new Array(LINE_COUNT).fill(0) },
      uLineVis: { value: new Array(LINE_COUNT).fill(0) },
      uLineCol: { value: new Array(LINE_COUNT * 3).fill(0) },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uSensitivity,uIntensity,uComplexity,uAspect;
      // Per-line values, computed once a frame in the component: the level the
      // line sits at, how sharp it is, its audio gate, its energy, its colour.
      uniform float uLineLvl[7],uLineSharp[7],uLineE[7],uLineVis[7];
      uniform vec3 uLineCol[7];

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
      void main(){
        vec2 p=(vUv-0.5)*2.0; p.x*=uAspect;

        float t=uTime*0.12;
        float detail=1.8+uComplexity*0.9;

        vec2 q=vec2(fbm(p*detail+vec2(0.0,t*0.8)),
                    fbm(p*detail+vec2(t*0.6,0.0)));
        vec2 r=vec2(fbm(p*detail+q*2.0+vec2(t*0.5,-t*0.4)),
                    fbm(p*detail+q*2.0-vec2(t*0.35,t*0.45)));
        float f=fbm(p*detail+r*1.8);

        vec3 col=vec3(0.010,0.010,0.030);
        col+=vec3(0.05,0.04,0.10)*f*0.25;

        // Per line, only what depends on the field is left: the distance from
        // the line's level and the resulting glow. The level, sharpness, gate,
        // energy and colour all arrive as uniforms.
        for(int i=0;i<7;i++){
          float d=f-uLineLvl[i];
          float line=exp(-d*d*uLineSharp[i]);
          line*=uLineVis[i];

          float e=uLineE[i];
          vec3 bc=uLineCol[i];

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
    const time = state.clock.elapsedTime * speed
    u.uTime.value = time
    u.uSensitivity.value = sensitivity
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height

    const arr = envelope.current
    const pk = peaks.current
    // The line values, for the same 7 lines the shader draws. The hue shift
    // folds in here for the reason it did in the shader: every line's colour
    // depends on it. `-0.5556` is the shader's own offset, kept as it was.
    const lvl = u.uLineLvl.value as number[]
    const sharp = u.uLineSharp.value as number[]
    const energies = u.uLineE.value as number[]
    const visible = u.uLineVis.value as number[]
    const colours = u.uLineCol.value as number[]
    const hueBase = hueShift / 360 - 0.5556

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

      // 4) the line's own values. `e` is the shader's pow(clamp(band),2.2) and
      //    `vis` its smoothstep gate; both are one value per band, not per pixel.
      const e = Math.pow(Math.min(Math.max(arr[i], 0), 1), 2.2)
      energies[i] = e
      visible[i] = smoothstep(0.03, 0.55, e)
      lvl[i] = 0.12 + i * 0.115 + 0.04 * Math.sin(time * 0.35 + i * 1.7)
      sharp[i] = 140 + i * 45
      const [r, g, b] = hsv2rgb(fract(LINE_HUES[i] + hueBase), 0.9, 1)
      colours[i * 3] = r
      colours[i * 3 + 1] = g
      colours[i * 3 + 2] = b
    }
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}
