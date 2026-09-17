import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData } from '../../audio'
import { readBands } from './bands'
import { useWaveTrace } from './useWaveTrace'
import { AM_TUNE } from './amTune'

export default function AM2Preset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },

      uAmpQuiet: { value: AM_TUNE.ampQuiet },
      uAmpEnergy: { value: AM_TUNE.ampEnergy },
      uGain: { value: AM_TUNE.gain },

      uThickMin: { value: AM_TUNE.thickMin },
      uThickEnergy: { value: AM_TUNE.thickEnergy },
      uBassGate: { value: 1 },
      uMidGate: { value: 1 },
      uTrebleGate: { value: 1 },
      uSpacing: { value: AM_TUNE.spacing },
      uSoft: { value: AM_TUNE.soft },

      uMirror: { value: AM_TUNE.mirror ? 1 : 0 },
      uFlip: { value: 0 },
    },

    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      varying vec2 vUv;

      uniform float uTime;
      uniform float uBass;
      uniform float uMid;
      uniform float uTreble;
      uniform float uAspect;

      uniform float uAmpQuiet;
      uniform float uAmpEnergy;
      uniform float uGain;

      uniform float uThickMin;
      uniform float uThickEnergy;
      uniform float uBassGate;
      uniform float uMidGate;
      uniform float uTrebleGate;
      uniform float uSpacing;
      uniform float uSoft;

      uniform float uMirror;
      uniform float uFlip;

      uniform sampler2D uWave;

      // Draw one waveform divider inside a local vertical band.
      float drawWave(
        float center,
        float band,
        float bandAmp,
        float thickness
      ) {
        float t = vUv.x;

        if (uMirror > 0.5) {
          t = abs(vUv.x - 0.5) * 2.0;
        }

        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - uSpacing, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + uSpacing, 0.5)).r;

        float y = center + (s - 0.5) * 2.0 * bandAmp;

        float dsdt = (sR - sL) / (2.0 * uSpacing);
        float dydx = bandAmp * dsdt / uAspect;

        float dist = abs(vUv.y - y) / sqrt(1.0 + dydx * dydx);

        return 1.0 - smoothstep(
          thickness - uSoft,
          thickness,
          dist
        );
      }

      void main() {
        // Independent response for each frequency band.
        float bassAmp =
          (uAmpQuiet + uBass * uAmpEnergy)
          * uGain
          * 0.25;

        float midAmp =
          (uAmpQuiet + uMid * uAmpEnergy)
          * uGain
          * 0.75;

        float trebleAmp =
          (uAmpQuiet + uTreble * uAmpEnergy)
          * uGain
          * 0.25;

        // Three horizontal divider positions.
        float bassY = 0.50;
        float midY = 0.50;
        float trebleY = 0.50;

        // Slightly different thickness per band.
        float bassThickness =
          uThickMin + uBass * uThickEnergy;

        float midThickness =
          uThickMin * 0.82 + uMid * uThickEnergy * 0.72;

        float trebleThickness =
          uThickMin * 0.68 + uTreble * uThickEnergy * 0.55;

        float bass = drawWave(
          bassY,
          0.0,
          bassAmp,
          bassThickness
        ) * uBassGate;

        float mid = drawWave(
          midY,
          0.0,
          midAmp,
          midThickness
        ) * uMidGate;

        float treble = drawWave(
          trebleY,
          0.0,
          trebleAmp,
          trebleThickness
        ) * uTrebleGate;

        float line = max(bass, max(mid, treble));

        // Flip: white on black <-> black on white.
        float shade = mix(
          line,
          1.0 - line,
          uFlip
        );

        gl_FragColor = vec4(vec3(shade), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed, bassAmp, midAmp, trebleAmp } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData())

    refresh(AM_TUNE.follow)

    const u = materialRef.current.uniforms

    u.uTime.value = state.clock.elapsedTime * speed

    u.uBass.value =
      Math.min(b.bass * sensitivity * bassAmp, 1.0)

    u.uMid.value =
      Math.min(b.mid * sensitivity * midAmp, 1.0)

    u.uTreble.value =
      Math.min(b.treble * sensitivity * trebleAmp, 1.0)

    // Amp at 0 = band gone entirely (kills the quiet-floor remnant too).
    u.uBassGate.value =
      bassAmp > 0 ? 1 : 0

    u.uMidGate.value =
      midAmp > 0 ? 1 : 0

    u.uTrebleGate.value =
      trebleAmp > 0 ? 1 : 0

    u.uAspect.value =
      viewport.width / viewport.height

    u.uAmpQuiet.value =
      AM_TUNE.ampQuiet

    u.uAmpEnergy.value =
      AM_TUNE.ampEnergy

    u.uGain.value =
      AM_TUNE.gain

    u.uThickMin.value =
      AM_TUNE.thickMin

    u.uThickEnergy.value =
      AM_TUNE.thickEnergy

    u.uSpacing.value =
      AM_TUNE.spacing

    u.uSoft.value =
      AM_TUNE.soft

    u.uMirror.value =
      AM_TUNE.mirror ? 1 : 0

    u.uFlip.value =
      useStore.getState().amFlip ? 1 : 0
  })

  return (
    <mesh>
      <planeGeometry
        args={[viewport.width, viewport.height]}
      />
      <shaderMaterial
        ref={materialRef}
        {...shader}
      />
    </mesh>
  )
}
