import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, presetParamsFor } from '../../store'
import { getFreqData, readBands } from '../../audio'
import { useWaveTrace } from './useWaveTrace'

export default function WaveformPreset() {
  const materialRef = useRef<THREE.ShaderMaterial>(null!)
  const viewport = useThree((state) => state.viewport)

  const { tex: waveTex, refresh } = useWaveTrace()

  const shader = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uWave: { value: waveTex },
      uAspect: { value: 1 },
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
      uniform sampler2D uWave;   // 0..1, 0.5 = silence

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        p.x *= uAspect;

        float amp = 0.05 + uBass * 0.45;

        // Plot real audio: x position -> sample in the rolling window
        float t  = vUv.x;
        float s  = texture2D(uWave, vec2(t, 0.5)).r;
        float sL = texture2D(uWave, vec2(t - 0.002, 0.5)).r;
        float sR = texture2D(uWave, vec2(t + 0.002, 0.5)).r;

        float y = (s - 0.5) * 2.0 * amp;

        // Keep your perpendicular-distance trick (still needed for thick
        // consistent strokes on steep transients like kick drums)
        float dsdt = (sR - sL) / 0.004;
        float dydx = amp * dsdt / uAspect;
        float dist = abs(p.y - y) / sqrt(1.0 + dydx * dydx);

        float thickness = 0.001 + uBass * 0.01;
        float line = 1.0 - smoothstep(thickness - 0.004, thickness, dist);

        gl_FragColor = vec4(vec3(line), 1.0);
      }
    `,
  }), [waveTex])

  useFrame((state) => {
    const { sensitivity, speed } = presetParamsFor(useStore.getState())
    const b = readBands(getFreqData()) // shared bass/mid/treble bands, unchanged

    refresh(1) // raw time-domain trace → texture

    const u = materialRef.current.uniforms
    u.uTime.value = state.clock.elapsedTime * speed
    u.uBass.value = Math.min(b.bass * sensitivity, 1.0)
    u.uAspect.value = viewport.width / viewport.height
  })

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial ref={materialRef} {...shader} />
    </mesh>
  )
}
