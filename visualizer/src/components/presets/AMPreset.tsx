import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData, readBands } from '../../audio'
import { useWaveTrace } from './useWaveTrace'
import { AM_TUNE } from './amTune'

/**
 * AM Preset — an exact WaveformPreset copy (raw rolling time-domain trace,
 * bass-reactive amplitude + thickness, crisp white stroke) with every magic
 * number lifted into AM_TUNE so each behavior has a code control. Defaults
 * reproduce WaveformPreset 1:1 (follow 1, mirror off, gain 1).
 */
export default function AMPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },
      uAmpQuiet: { value: AM_TUNE.ampQuiet },
      uAmpEnergy: { value: AM_TUNE.ampEnergy },
      uGain: { value: AM_TUNE.gain },
      uThickMin: { value: AM_TUNE.thickMin },
      uThickEnergy: { value: AM_TUNE.thickEnergy },
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
      uniform float uTime, uBass, uAspect;
      uniform float uAmpQuiet, uAmpEnergy, uGain;
      uniform float uThickMin, uThickEnergy;
      uniform float uSpacing, uSoft;
      uniform float uMirror;
      uniform float uFlip;
      uniform sampler2D uWave;   // 0..1, 0.5 = silence

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        p.x *= uAspect;

        float amp = (uAmpQuiet + uBass * uAmpEnergy) * uGain;

        // Plot real audio: x position -> sample in the rolling window
        float t = vUv.x;
        if (uMirror > 0.5) {
          t = abs(vUv.x - 0.5) * 2.0;
        }
        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - uSpacing, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + uSpacing, 0.5)).r;

        float y = (s - 0.5) * 2.0 * amp;

        // Keep the perpendicular-distance trick (still needed for thick
        // consistent strokes on steep transients like kick drums)
        float dsdt = (sR - sL) / (2.0 * uSpacing);
        float dydx = amp * dsdt / uAspect;
        float dist = abs(p.y - y) / sqrt(1.0 + dydx * dydx);

        float thickness = uThickMin + uBass * uThickEnergy;
        float line = 1.0 - smoothstep(thickness - uSoft, thickness, dist);

        // Flip inverts the palette: white stroke on black <-> black stroke on white.
        float shade = mix(line, 1.0 - line, uFlip);
        gl_FragColor = vec4(vec3(shade), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData()) // shared bass/mid/treble bands, unchanged

    refresh(AM_TUNE.follow) // raw time-domain trace → texture

    // Only the values that can change per frame are written: the AM_TUNE
    // constants above are already in place from the initial uniforms object.
    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = Math.min(b.bass * sensitivity, 1.0)
    u.uAspect.value = viewport.width / viewport.height
    u.uFlip.value = useStore.getState().amFlip ? 1 : 0
  })

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial ref={materialRef} {...shader} />
    </mesh>
  )
}
