import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getAnalysis, readVisualBands } from '../../analyser'

export default function AcidWashPreset() {
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
