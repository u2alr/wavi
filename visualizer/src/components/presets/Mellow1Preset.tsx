import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData } from '../../audio'
import { readBands } from './bands'

export default function Mellow1Preset() {
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
