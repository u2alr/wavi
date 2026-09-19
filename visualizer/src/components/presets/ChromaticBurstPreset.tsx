import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getAnalysis, readVisualBands } from '../../analyser'
import { fract, hsv2rgb, smoothstep } from './glsl'

// The hue each of the seven rays owns. The shader used to hold these and turn
// them into colours per pixel; see uBandCol.
const BAND_HUES = [0.97, 0.05, 0.13, 0.30, 0.45, 0.60, 0.78]
const BAND_COUNT = BAND_HUES.length

export default function ChromaticBurstPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.05))
  const rawBands = useMemo(() => new Array<number>(7).fill(0), [])
  // The envelope-follower output, which the shader no longer needs to see: it
  // only reads uBandE, the processed version of it.
  const envelope = useRef(new Float64Array(7))
  const vocal = useRef(0)

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 1.5 }, uAspect: { value: 1 },
      // Per-frame values the shader would otherwise derive for every pixel:
      // pow(clamp(band),1.6) per band, the seven ray colours, and the loudness
      // gate over the strongest band.
      uBandE: { value: new Array(BAND_COUNT).fill(0) },
      uBandCol: { value: new Array(BAND_COUNT * 3).fill(0) },
      uAudio: { value: 0 },
      uLineCount: { value: 60.0 },
      uPushStrength: { value: 0.8 },
      uWaveSpeed: { value: 1.8 },
      uTaper: { value: 0.1 },
      uRotationSpeed: { value: 0.2 },
      uZoom: { value: 2.0 },           // 1.0 = normal, 2.0 = zoomed in 2x
      uVocal: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uIntensity,uAspect,uLineCount,uPushStrength,uWaveSpeed,uTaper,uRotationSpeed,uZoom,uVocal;
      // Per-frame values, computed in the component: the processed band energies,
      // the colour each ray owns, and the gate over the loudest band.
      uniform float uBandE[7];
      uniform vec3 uBandCol[7];
      uniform float uAudio;

      float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
      float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
      float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*vnoise(p);p=p*2.03+vec2(9.2,-5.4);a*=.5;}return v;}

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;

        // ZOOM APPLIED HERE
        p /= uZoom;

        // Band energies arrive processed, and the loudness gate with them: only
        // the mid aggregate they feed still has to be taken here.
        float mid =(uBandE[2]+uBandE[3]+uBandE[4])/3.0;
        float audio=uAudio;

        float r=length(p);
        float a=atan(p.y,p.x);
        float t=uTime;

        vec3 col=vec3(0.00,0.000,0.00);

        for(int layer=0;layer<3;layer++){
          float lf=float(layer);

          float rot=t*(0.3+lf*0.15)*uRotationSpeed+lf*0.5+mid*0.05*uRotationSpeed;
          float angle=a+rot;

          float lineIdx=floor((angle+3.14159)/(6.28318/uLineCount));
          float bandIdx=mod(lineIdx,7.0);
          int bi=int(bandIdx);
          float eb=uBandE[bi];

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

          vec3 lc=uBandCol[bi];

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
    u.uIntensity.value = intensity
    u.uAspect.value = viewport.width / viewport.height

    const arr = envelope.current
    const pk = peaks.current
    const bandE = u.uBandE.value as number[]
    const bandCol = u.uBandCol.value as number[]
    const HEADROOM = 1.6
    vocal.current += (Math.min(analysis.vocalPresence, 1) - vocal.current) * (1 - Math.exp(-dt * 6))
    u.uVocal.value = vocal.current

    let strongest = 0
    for (let i = 0; i < 7; i++) {
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.15, bands[i], 0.05)
      const norm = Math.min(bands[i] / (pk[i] * HEADROOM), 1)
      const target = Math.pow(norm, 1.5)
      const k = target > arr[i]
        ? 1 - Math.exp(-dt * 12)
        : 1 - Math.exp(-dt * 4)
      arr[i] += (target - arr[i]) * k

      // What the shader used to work out per pixel: the band's processed
      // energy, the loudest of the seven, and the colour its ray draws in.
      const e = Math.pow(Math.min(Math.max(arr[i], 0), 1), 1.6)
      bandE[i] = e
      if (e > strongest) strongest = e
      const [r, g, b] = hsv2rgb(fract(BAND_HUES[i] + hueShift / 360), 0.85, 1)
      bandCol[i * 3] = r
      bandCol[i * 3 + 1] = g
      bandCol[i * 3 + 2] = b
    }
    u.uAudio.value = smoothstep(0.01, 0.3, strongest)
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}
