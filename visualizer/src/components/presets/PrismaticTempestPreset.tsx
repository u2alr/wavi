import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData, getSampleRate } from '../../audio'

const edgeCache = new Map<string, number[]>()

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

export default function PrismaticTempestPreset() {
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
