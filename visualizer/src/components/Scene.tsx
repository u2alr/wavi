import { useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { getFreqData } from '../audio'

function readBands(frequency: Uint8Array) {
  let bass = 0, mid = 0, treble = 0
  const bassEnd = Math.floor(frequency.length * 0.1)
  const midEnd = Math.floor(frequency.length * 0.4)
  for (let i = 0; i < bassEnd; i++) bass += frequency[i]
  for (let i = bassEnd; i < midEnd; i++) mid += frequency[i]
  for (let i = midEnd; i < frequency.length; i++) treble += frequency[i]
  return {
    bass: bass / (bassEnd * 255),
    mid: mid / ((midEnd - bassEnd) * 255),
    treble: treble / ((frequency.length - midEnd) * 255),
  }
}

function PrismaticBloomPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 }, uAspect: { value: 1 },
    },
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBass,uMid,uTreble,uSensitivity,uHueShift,uIntensity,uAspect;
      vec3 hsv(vec3 c){vec4 k=vec4(1.,.666666,.333333,3.);vec3 p=abs(fract(c.xxx+k.xyz)*6.-k.www);return c.z*mix(k.xxx,clamp(p-k.xxx,0.,1.),c.y);}

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;

        float bass=min(uBass*uSensitivity,1.5);
        float mid=min(uMid*uSensitivity,1.5);
        float high=min(uTreble*uSensitivity,1.5);

        float r=length(p);
        float a=atan(p.y,p.x);

        float spin=uTime*0.6+mid*0.08;
        float bloom=0.8+bass*0.30;
        float k=8.0;

        float lobe=pow(0.5+0.5*cos(a*k+spin),1.4);
        float sep=smoothstep(0.10,0.45,lobe);
        float R=(0.30+0.95*lobe)*bloom;
        float d=r-R;
        float body=(1.0-smoothstep(-0.05,0.08,d))*sep;
        float rib=pow(sin(d*34.0-uTime*2.0)*0.5+0.5,1.6);

        float lobe2=pow(0.5-0.5*cos(a*k+spin),1.4);
        float sep2=smoothstep(0.10,0.45,lobe2);
        float R2=(0.22+0.65*lobe2)*bloom*(0.85+high*0.15);
        float d2=r-R2;
        float body2=(1.0-smoothstep(-0.04,0.06,d2))*sep2;
        float rib2=pow(sin(d2*42.0+uTime*2.4)*0.5+0.5,1.6);

        float glow=(body*rib+body2*rib2*0.6)*uIntensity;
        float core=pow(max(0.0,1.0-r*2.4),2.0)*(0.4+bass*0.8);

        float hue=fract(uHueShift/360.0+r*0.22+lobe*0.10+uTime*0.02);
        vec3 color=hsv(vec3(hue,0.80+high*0.10,glow));
        color+=vec3(0.10,0.42,0.22)*body*0.6;
        color+=vec3(0.98,0.75,0.25)*rib*body*high*0.4;
        color+=hsv(vec3(hue,0.6,1.0))*core;
        color+=vec3(0.02,0.06,0.10)*(1.0-smoothstep(1.1,2.0,r));
        gl_FragColor=vec4(color,1.0);
      }
    `,
  }), [])

  useFrame((state) => {
    const b = readBands(getFreqData())
    const { sensitivity, hueShift, intensity, speed } = useStore.getState().params
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uTreble.value = b.treble
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uAspect.value = viewport.width / viewport.height
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function MellowDriftPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
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
        for(int i=0;i<3;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.52; }
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

        vec3 col=mix(deep,plum,smoothstep(0.15,0.55,f));
        col=mix(col,rose,smoothstep(0.45,0.80,f+mid*0.25));
        col=mix(col,amber,smoothstep(0.65,0.95,f)*(0.5+0.5*q.x));

        vec3 accent=hsv2rgb(vec3(uHueShift/360.0,0.45,0.9));
        col=mix(col,accent,smoothstep(0.55,0.9,q.y)*0.35);

        col+=cream*pow(max(0.0,f-0.55),2.0)*(0.6+bass*1.5);

        col*=1.0-smoothstep(0.81,4.0,dot(p,p))*0.55;
        col*=uIntensity*(0.75+bass*0.20);
        
        float energy = bass * 0.5 + mid * 0.3 + high * 0.2;
        float flash = smoothstep(0.4, 1.2, energy) * 0.6; 
        col *= 1.0 + flash; 

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state) => {
    const b = readBands(getFreqData())
    const { sensitivity, hueShift, intensity, speed, complexity } = useStore.getState().params
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
        for(int i=0;i<3;i++){ v+=a*vnoise(p); p=p*2.03+vec2(13.7,-7.1); a*=0.5; }
        return v;
      }
      vec3 hsv2rgb(vec3 c){
        vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
        vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
        return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
      }

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;
        float bass=uBass, mid=uMid, high=uTreble;

        float r0=length(p);
        float a=atan(p.y,p.x);

        // CONSTANT spin
        float ang=a+uTime*0.12+0.7/(r0+0.35);
        vec2 dir=vec2(cos(ang),sin(ang));
        vec2 q=dir*r0;

        float detail=2.0+uComplexity*1.2;

        vec2 w=vec2(fbm(q*detail*vec2(1.0,1.7)+vec2(0.0,uTime*0.22)),
                    fbm(q*detail*vec2(1.7,1.0)+vec2(uTime*0.18,0.0)));
        float smoke=fbm(q*detail+w*(3.2+mid*0.6)+vec2(-uTime*0.10,uTime*0.08));

        float rings=sin(r0*(7.0+uComplexity*3.0)-uTime*0.5+smoke*3.5)*0.5+0.5;
        rings=pow(rings,1.6);

        // thin filament lines
        float ridge=1.0-abs(2.0*fbm(q*detail*1.8+w*3.0+vec2(uTime*0.12))-1.0);
        ridge=pow(ridge,5.0);

        // FLASH the lines with music - bass makes them thicker/brighter, treble adds sparkle
        float flash=1.0+bass*2.5+high*1.8;
        float thick=0.8+bass*0.6;
        ridge*=flash;
        ridge=pow(ridge,thick);

        float flare=pow(clamp((smoke-0.35)/0.65,0.0,1.0),2.0);

        float body=smoke*0.55+rings*smoke*0.85+flare*0.45;

        float h0=uHueShift/360.0;
        vec3 bg=hsv2rgb(vec3(h0+0.06,0.90,0.10));
        vec3 blue=hsv2rgb(vec3(h0+0.03,0.85,0.45));
        vec3 teal=hsv2rgb(vec3(h0,0.80,0.80));
        vec3 white=hsv2rgb(vec3(h0-0.04,0.25,1.0));

        vec3 col=bg;
        col=mix(col,blue,smoothstep(0.25,0.70,body));
        col=mix(col,teal,smoothstep(0.55,0.95,body)*0.85);

        // thin lines FLASH with music
        col+=teal*ridge*smoke*(0.8+bass*1.2);
        col+=white*ridge*smoke*(0.4+high*1.5);

        col*=1.0-smoothstep(1.2,2.2,length(p))*0.55;
        col*=uIntensity*0.9;
        col=1.0-exp(-col*1.3);
        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state) => {
    const b = readBands(getFreqData())
    const { sensitivity, hueShift, intensity, speed, complexity } = useStore.getState().params
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed

    // smooth audio following
    const sm = (key: 'uBass' | 'uMid' | 'uTreble', raw: number) => {
      const target = Math.min(raw * sensitivity, 1.5)
      const rate = target > u[key].value ? 0.6 : 2.0
      u[key].value += (target - u[key].value) * rate
    }
    sm('uBass', b.bass)
    sm('uMid', b.mid)
    sm('uTreble', b.treble)

    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function ActivePreset() {
  const currentPreset = useStore((state) => state.currentPreset)

  switch (currentPreset) {
    case 'prismaticGarden':
      return <PrismaticBloomPreset />
    case 'mellowDrift':
      return <MellowDriftPreset />
    case 'auroraSilk':
      return <AuroraSilkPreset />
    case 'brat':
      return null
    default:
      return <MellowDriftPreset />
  }
}

export default function Scene() {
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 55 }}>
      <color attach="background" args={['#020308']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[3, 4, 5]} intensity={1.1} />
      <ActivePreset />
    </Canvas>
  )
}