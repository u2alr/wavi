import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getAnalysis } from '../../analyser'

// 7 log-spread engine bands (of 32, 20Hz-20kHz) feeding SandsOfTime
// lines: ~23Hz, 59Hz, 140Hz, 331Hz, 785Hz, 2.3kHz, 10.5kHz.
const SAND_BAND_PICKS = [1, 5, 9, 13, 17, 22, 29]

export default function SandsOfTimePreset() {
  const viewport = useThree((state) => state.viewport)
  // Mostly a timepiece: flow / crawl / t are INTEGRATED (never scaled off
  // the wall clock) so changing `speed` can't jump the phase. Only treble
  // (sparkle), transients (hit flashes), loudness (glow) and vocals react
  // to sound — plus per-line band gating (each contour its own Hz region).
  const st = useRef({ flow: 0, crawl: 0, t: 0, eb: [0, 0, 0, 0, 0, 0, 0], treble: 0, hit: 0, loud: 0, vocal: 0, sparkT: 0, glow: 0, lastGlow: -9 })

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uEnergy: { value: 0 }, uBass: { value: 0 },
      uMid: { value: 0 }, uHigh: { value: 0 }, uKick: { value: 0 }, uBeat: { value: 0 },
      uFlow: { value: 0 }, uCrawl: { value: 0 },
      uBands: { value: [0, 0, 0, 0, 0, 0, 0] },
      uTreble: { value: 0 }, uHit: { value: 0 }, uLoud: { value: 0 }, uVocal: { value: 0 }, uSparkT: { value: 0 }, uPulse: { value: 0 },
      uSensitivity: { value: 1 }, uHueShift: { value: 200 }, uIntensity: { value: 1.5 },
      uComplexity: { value: 1 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime,uEnergy,uBass,uMid,uHigh,uKick,uBeat,uFlow,uCrawl,uSensitivity,uHueShift,uIntensity,uComplexity,uAspect;
      uniform float uBands[7];
      uniform float uTreble,uHit,uLoud,uVocal,uSparkT,uPulse;

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
        float peak = smoothstep(0.65, 1.0, max(uPulse, uHit));
        ridge = mix(ridge, vec3(1.0, 0.97, 0.92), peak*0.55);

        // warm near-black base
        vec3 col = vec3(0.020, 0.016, 0.012);

        // soft radial bloom at the dominant vortex, follows loudness
        vec2 gd = w - vec2(0.05, 0.25);
        col += vec3(0.45, 0.30, 0.16) * exp(-dot(gd, gd)*2.5) * uPulse * 0.7;

        // no fog: flat response, no top fade / vignette / center glow.
        // lines breathe up with the voice.
        float strength = (0.45 + pow(uVocal, 1.5)*1.55) * breathe * bright;

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

        // treble sparkle: short-lived bright flickers stuck to random lines,
        // plus a highlight traveling along the field. Both wake up on hits.
        float flSeed = hash21(floor(w*230.0) + floor(field*14.0) + floor(uSparkT*6.0));
        col += vec3(1.0,0.96,0.88) * step(1.0 - uTreble*0.30, flSeed) * (0.25 + uHit) * lg * 1.6;
        float trav = pow(0.5 + 0.5*sin(field*5.0 - uSparkT*14.0), 8.0);
        col += vec3(1.0,0.93,0.78) * trav * (0.15 + uHit*0.85) * lg * 0.8;

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

    // followers: treble shimmer, transient-hit envelope, loudness glow,
    // vocal lift. Everything else (bass/energy/kick/beat) stays frozen.
    const fol = (cur: number, tgt: number, atk: number, rel: number) =>
      cur + (tgt - cur) * (1 - Math.exp(-dt * (tgt > cur ? atk : rel)))

    s.treble = fol(s.treble, Math.min(((a.presence + a.treble + a.air) / 3) * sensitivity, 1), 10, 4)
    s.hit = fol(s.hit, Math.min(Math.max(a.transient, a.hatEnergy * 0.8, a.snareEnergy * 0.8) * sensitivity, 1), 16, 6)
    s.loud = fol(s.loud, Math.min(Math.max(a.kickEnergy, (a.bass + a.subBass * 0.5) * 0.8) * sensitivity, 1), 8, 4)
    s.vocal = fol(s.vocal, Math.min(a.vocalPresence * sensitivity, 1), 6, 4)

    // one-shot glow pulse per kick onset: 1 glow = 1 beat. Sustained bass
    // holds no glow — re-arm gate + min gap stop plateau retrigger.
    if (a.kickEnergy > 0.5 && s.glow < 0.35 && s.t - s.lastGlow > 0.18) {
      s.glow = 1
      s.lastGlow = s.t
    }
    s.glow *= Math.exp(-dt * 4)

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
    // highlight travel speeds up on hits.
    s.flow  += dt * speed * 0.06
    s.crawl += dt * 0.035
    s.t     += dt * speed
    s.sparkT += dt * (0.4 + s.hit * 4.0)

    u.uTime.value = s.t
    u.uEnergy.value = 0.55
    u.uBass.value = 0.45
    u.uMid.value = 0.5
    u.uHigh.value = 0.5
    u.uKick.value = 0
    u.uBeat.value = 0
    u.uFlow.value = s.flow
    u.uCrawl.value = s.crawl
    u.uTreble.value = s.treble
    u.uHit.value = s.hit
    u.uLoud.value = s.loud
    u.uVocal.value = s.vocal
    u.uPulse.value = s.glow
    u.uSparkT.value = s.sparkT
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
