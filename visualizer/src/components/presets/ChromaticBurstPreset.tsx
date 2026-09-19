import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getAnalysis, readVisualBands } from '../../analyser'

export default function ChromaticBurstPreset() {
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
      uRotationSpeed: { value: 0.2 },
      uZoom: { value: 2.0 },           // 1.0 = normal, 2.0 = zoomed in 2x
      uVocal: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uHueShift,uIntensity,uAspect,uLineCount,uPushStrength,uWaveSpeed,uTaper,uRotationSpeed,uZoom,uVocal;

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
