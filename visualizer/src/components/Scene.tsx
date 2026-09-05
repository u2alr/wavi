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

/** 7-band split (sub → low → low-mid → mid → high-mid → high → air) for
 * contour-style presets where each band owns its own visual channel. */
function readBands7(frequency: Uint8Array) {
  const edges = [0, 0.05, 0.1, 0.18, 0.28, 0.4, 0.55, 1]
  const out: number[] = []
  for (let b = 0; b < 7; b++) {
    const start = Math.floor(frequency.length * edges[b])
    const end = Math.max(start + 1, Math.floor(frequency.length * edges[b + 1]))
    let sum = 0
    for (let i = start; i < end; i++) sum += frequency[i]
    out.push(sum / ((end - start) * 255))
  }
  return out
}

function PrismaticBloomPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.05))

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 }, uAspect: { value: 1 },
      uZoom: { value: 1.5 },
      uPetalWidth: { value: 1.0 },
      uGap: { value: 0.1 },
      uBloom: { value: 4.0 },
      uGlow: { value: 2.0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uSensitivity,uHueShift,uIntensity,uAspect,uZoom,uPetalWidth,uGap,uBloom,uGlow;

      vec3 hsv(vec3 c){vec4 k=vec4(1.,.666666,.333333,3.);vec3 p=abs(fract(c.xxx+k.xyz)*6.-k.www);return c.z*mix(k.xxx,clamp(p-k.xxx,0.,1.),c.y);}
      float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
      float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
      float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*vnoise(p);p=p*2.03+vec2(9.2,-5.4);a*=.5;}return v;}

      void main(){
        vec2 p=(vUv-.5)*2.; p.x*=uAspect;
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

        float spin=t*0.6+mid*0.10;
        float bloom=(0.8+bass*0.30)*uBloom;
        float flash=1.0+high*0.6;

        float hs=uHueShift/360.0;
        float hues[7];
        hues[0]=0.97; hues[1]=0.05; hues[2]=0.13; hues[3]=0.30;
        hues[4]=0.45; hues[5]=0.60; hues[6]=0.78;

        vec3 col=vec3(0.012,0.014,0.030);
        col+=hsv(vec3(fract(hs+0.5),0.5,1.0))*fbm(p*3.0+t*0.1)*0.02*audio;

        // === OUTER PETAL FAMILY ===
        {
          float k=140.0;
          float phase=a*k+spin;
          float m=mod(floor(phase/6.28318),7.0);
          int bi=int(m);
          float eb=e[bi];

          float petal=pow(0.5+0.5*cos(phase), 1.6 / uPetalWidth);
          float sep=smoothstep(uGap, uGap+0.20, petal);
          float R=(0.30+0.95*petal)*bloom*(0.90+eb*0.20);
          float d=r-R;
          float body=(1.0-smoothstep(-0.05,0.08, d / uPetalWidth))*sep;
          float rib=pow(sin(d*34.0-t*2.0)*0.5+0.5,1.6);

          float gate=smoothstep(0.03,0.55,eb)*audio;
          float glow=body*rib*gate*flash;

          vec3 pc=hsv(vec3(fract(hues[bi]+hs),0.90,1.0));
          col+=pc*glow*uIntensity;
          col+=vec3(1.0)*glow*eb*eb*0.25;

          float halo=(1.0-smoothstep(-0.12,0.35,d/uPetalWidth))*sep;
          col+=pc*halo*halo*gate*0.45*uGlow;
        }

        // === INNER PETAL FAMILY ===
        {
          float k=70.0;
          float phase=a*k-spin*1.35+3.14159;
          float m=mod(floor(phase/6.28318),7.0);
          int bi=int(m);
          float eb=e[bi];

          float petal=pow(0.5+0.5*cos(phase), 1.8 / uPetalWidth);
          float sep=smoothstep(uGap, uGap+0.20, petal);
          float R=(0.18+0.55*petal)*bloom*(0.85+high*0.15);
          float d=r-R;
          float body=(1.0-smoothstep(-0.04,0.06, d / uPetalWidth))*sep;
          float rib=pow(sin(d*42.0+t*2.4)*0.5+0.5,1.6);

          float gate=smoothstep(0.05,0.60,eb)*audio;
          float glow=body*rib*gate*0.6;

          vec3 pc=hsv(vec3(fract(hues[bi]+hs),0.90,1.0));
          col+=pc*glow*uIntensity;

          float halo=(1.0-smoothstep(-0.10,0.30,d/uPetalWidth))*sep;
          col+=pc*halo*halo*gate*0.35*uGlow;
        }

        // === CORE HEART (REMOVED) ===
        // The center glow is gone. The middle is now dark/empty.

        col*=1.0-smoothstep(1.1,2.0,r)*0.7;
        col=col/(1.0+col*0.7);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const bands = readBands7(getFreqData())
    const { sensitivity, hueShift, intensity, speed } = useStore.getState().params
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uAspect.value = viewport.width / viewport.height

    const arr = u.uBands.value as number[]
    const pk = peaks.current
    const HEADROOM = 1.6

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
        for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.02+vec2(13.7,-7.1); a*=0.52; }
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
  // running per-band peaks for auto-gain (bass, mid, treble)
  const peaks = useRef(new Float64Array(3).fill(0.02))

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
    const b = readBands(getFreqData())
    const { sensitivity, hueShift, intensity, speed, complexity } = useStore.getState().params
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uComplexity.value = complexity
    u.uAspect.value = viewport.width / viewport.height

    // 1) auto-gain per band — bass no longer drowns mid/treble
    const raw = [b.bass, b.mid, b.treble]
    const pk = peaks.current
    for (let i = 0; i < 3; i++) {
      pk[i] = Math.max(pk[i] - pk[i] * dt * 0.25, raw[i], 0.02)
    }
    const norm = raw.map((v, i) => Math.min(v / pk[i], 1))

    // 2) sensitivity as pre-gain, clamped to 0..1
    const target = norm.map((v) => Math.pow(Math.min(v * sensitivity, 1), 1.6))

    // 3) envelope follower: fast attack (~60ms), musical release (~250ms)
    const vals = [u.uBass.value, u.uMid.value, u.uTreble.value]
    for (let i = 0; i < 3; i++) {
      const k = target[i] > vals[i]
        ? 1 - Math.exp(-dt * 16)
        : 1 - Math.exp(-dt * 4)
      vals[i] += (target[i] - vals[i]) * k
    }
    u.uBass.value = vals[0]
    u.uMid.value = vals[1]
    u.uTreble.value = vals[2]
  })

  return <mesh><planeGeometry args={[viewport.width, viewport.height]} /><shaderMaterial ref={materialRef} {...shader} /></mesh>
}

function LiquidDriftPreset() {
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

function ArcticSwirlPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.02))

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
    const bands = readBands7(getFreqData())
    const { sensitivity, hueShift, intensity, speed, complexity } = useStore.getState().params
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

function LaserSilkPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  // running per-band peak for auto-gain (adapts to any input level)
  const peaks = useRef(new Float64Array(7).fill(0.02))

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
    const bands = readBands7(getFreqData())
    const { sensitivity, hueShift, intensity, speed, complexity } = useStore.getState().params
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
function SonarBloomPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)
  const peaks = useRef(new Float64Array(7).fill(0.05))

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 }, uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 }, uAspect: { value: 1 },
      uLineCount: { value: 82.0 },
      uPushStrength: { value: 0.2 },
      uWaveSpeed: { value: 1.5 },      
      uTaper: { value: 0.8},          
      uCoreSize: { value: 16.0 },       
      uRotationSpeed: { value: 0.2 },  
      uZoom: { value: 2.0 },           // <--- ZOOM IS BACK! (1.0 = normal, 2.0 = zoomed in 2x)
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uBands[7],uSensitivity,uHueShift,uIntensity,uAspect,uLineCount,uPushStrength,uWaveSpeed,uTaper,uCoreSize,uRotationSpeed,uZoom;

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

        vec3 col=vec3(0.008,0.008,0.025);
        col+=hsv(vec3(fract(hs+0.5),0.5,1.0))*fbm(p*3.0+t*0.1)*0.015*audio;

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

          vec3 lc=hsv(vec3(fract(hues[bi]+hs),0.85,1.0));
          
          float layerBright=1.0-lf*0.3;
          col+=lc*glow*uIntensity*layerBright;
          col+=vec3(1.0)*glow*eb*eb*0.3*layerBright;
        }

        float coreGlow=exp(-r*r*uCoreSize)*(0.3+bass*1.2)*audio;
        col+=hsv(vec3(fract(hs+t*0.03),0.7,1.0))*coreGlow*0.6;

        col*=1.0-smoothstep(1.2,2.2,r)*0.6;
        col=col/(1.0+col*0.7);

        gl_FragColor=vec4(col,1.0);
      }
    `,
  }), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const bands = readBands7(getFreqData())
    const { sensitivity, hueShift, intensity, speed } = useStore.getState().params
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uSensitivity.value = sensitivity
    u.uHueShift.value = hueShift
    u.uIntensity.value = intensity
    u.uAspect.value = viewport.width / viewport.height

    const arr = u.uBands.value as number[]
    const pk = peaks.current
    const HEADROOM = 1.6

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

function ActivePreset() {
  const currentPreset = useStore((state) => state.currentPreset)

  switch (currentPreset) {
    case 'prismaticGarden':
      return <PrismaticBloomPreset />
    case 'auroraSilk':
      return <AuroraSilkPreset />
    case 'liquidDrift':
      return <LiquidDriftPreset />
    case 'arcticSwirl':
      return <ArcticSwirlPreset />
    case 'laserSilk':
      return <LaserSilkPreset />
    case 'sonarBloom':
      return <SonarBloomPreset />
    case 'brat':
      return null
    default:
      return <MellowDriftPreset />
  }
}

export default function Scene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 55 }}
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: 'high-performance', depth: false, stencil: false }}
    >
      <color attach="background" args={['#020308']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[3, 4, 5]} intensity={1.1} />
      <ActivePreset />
    </Canvas>
  )
}