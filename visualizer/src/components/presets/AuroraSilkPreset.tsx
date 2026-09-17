import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData } from '../../audio'
import { readBands } from './bands'

// Uniform keys for the 3-band envelope followers — module const so the
// per-frame loop never allocates a key array.
const BAND_UNIFORMS = ['uBass', 'uMid', 'uTreble'] as const

export default function AuroraSilkPreset() {
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

      // Hash without a sine (Dave Hoskins). The classic
      // fract(sin(dot(p,k))*43758.5453) form evaluates sin() on an argument in
      // the hundreds and then multiplies by ~4.4e4, so the range-reduction
      // difference between GL implementations is amplified into a different
      // hash cell: the smoke field decorrelates and the frame changes shape
      // from one GPU to the next. This form is only +, *, dot and fract, all of
      // which every implementation evaluates the same way, so the field is
      // renderer-independent. It also feeds fbm twice over (the smoke input
      // includes two fbm results), which is why any hash error here shows up
      // multiplied rather than as a little grain.
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
