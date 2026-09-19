import { useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store'
import { startAnalysis, stopAnalysis } from '../analyser'
import { usePauseWhenUnfocused } from '../windowFocus'
import { countFrame } from '../frameStats'
import { resolveDpr, useRenderScale } from '../renderScale'
import Mellow2Preset from './presets/Mellow2Preset'
import Mellow1Preset from './presets/Mellow1Preset'
import PrismaticTempestPreset from './presets/PrismaticTempestPreset'
import SandsOfTimePreset from './presets/SandsOfTimePreset'
import AcidWashPreset from './presets/AcidWashPreset'
import ChromaticBurstPreset from './presets/ChromaticBurstPreset'
import WaveformPreset from './presets/WaveformPreset'
import AMPreset from './presets/AMPreset'
import AM2Preset from './presets/AM2Preset'
import CanvasAmbientPreset from './presets/CanvasAmbientPreset'
import CanvasAmbient2Preset from './presets/CanvasAmbient2Preset'

// One module per preset under ./presets. This file owns the canvas itself: the
// R3F shell, the preset switch and the frame-rate gate. Shared preset helpers
// (band reading, the wave trace, AM tuning) live beside them.
function ActivePreset() {
  const currentPreset = useStore((state) => state.currentPreset)

  switch (currentPreset) {
    case 'amPreset':
      return <AMPreset />
    case 'am2Preset':
      return <AM2Preset />
    case 'brat':
      return null
    case 'canvasAmbient':
      return <CanvasAmbientPreset />
    case 'canvasAmbient2':
      return <CanvasAmbient2Preset />
    case 'chromaticBurst':
      return <ChromaticBurstPreset />
    case 'mellow1':
      return <Mellow1Preset />
    case 'mellow2':
      return <Mellow2Preset />
    case 'prismaticTempest':
      return <PrismaticTempestPreset />
    case 'sandsOfTime':
      return <SandsOfTimePreset />
    case 'acidWash':
      return <AcidWashPreset />
    case 'waveform':
      return <WaveformPreset />
    default:
      return <CanvasAmbientPreset />
  }
}

/**
 * FPS cap for demand-mode rendering. Interval-driven invalidate() requests
 * one frame per tick; R3F renders nothing in between. No-op when unlimited.
 */
function FpsGate({ limit }: { limit: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (limit <= 0) return
    const id = window.setInterval(invalidate, 1000 / limit)
    return () => window.clearInterval(id)
  }, [limit, invalidate])
  return null
}

/**
 * Reports the rate the scene is actually drawing at, for the status bar.
 *
 * `useFrame` fires per rendered frame, which is exactly the number wanted and
 * is not what a requestAnimationFrame loop outside the canvas measures — in
 * 'demand' mode this runs on the invalidated frames only, so the cap shows up
 * here. See frameStats.ts.
 */
function FrameMeter() {
  useFrame(() => countFrame())
  return null
}

/**
 * One frame as soon as the renderer is un-parked.
 *
 * Only a capped loop needs this: it runs on 'demand', where nothing is drawn
 * until something asks, and its gate is an interval that can be a full second
 * long. Without this the user would return to a canvas holding the frame from
 * before the pause for up to that long.
 */
function ResumeFrame({ paused }: { paused: boolean }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (!paused) invalidate()
  }, [paused, invalidate])
  return null
}

export default function Scene() {
  const fpsLimit = useStore((s) => s.fpsLimit)
  const currentPreset = useStore((s) => s.currentPreset)
  const pauseWhenUnfocused = useStore((s) => s.pauseWhenUnfocused)
  const unfocused = usePauseWhenUnfocused()
  // Both hooks above are always called; only their combination is conditional,
  // which is what hooks require.
  const paused = pauseWhenUnfocused && unfocused

  // The cap decides how many frames are asked for; this decides how expensive
  // each one is. A preset is a full-screen fragment shader, so a machine whose
  // GPU cannot fill the buffer at the requested rate has one lever left that
  // does not change the look — fewer pixels. See renderScale.ts. The result is
  // the same 1..1.5 clamp on the device ratio as before, times the scaler's
  // multiplier, so an unadapted canvas renders exactly what it used to.
  const scale = useRenderScale({ fpsLimit, preset: currentPreset, parked: paused })

  // Playback is untouched by any of this: the local player is an <audio> element
  // behind the Web Audio graph and Spotify's runs in the SDK's own iframe, so
  // neither stops when the page stops asking for frames. The analysis pipeline
  // is a different matter — it exists to feed the shaders, and it is the second
  // half of what an unfocused window is spending, so it stops with the drawing.
  useEffect(() => {
    if (paused) stopAnalysis()
    else startAnalysis()
  }, [paused])

  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 55 }}
      dpr={resolveDpr(window.devicePixelRatio, scale)}
      // 'never' stops the drawing entirely — no useFrame subscribers, no shader
      // uniform updates, no draw calls — while the canvas and its GL context
      // stay alive, which is what makes the resume a frame instead of a remount.
      // (R3F's own rAF chain keeps ticking empty under 'never'; the GPU work is
      // the part that stops.)
      frameloop={paused ? 'never' : fpsLimit > 0 ? 'demand' : 'always'}
      gl={{ antialias: false, powerPreference: 'high-performance', depth: false, stencil: false }}
    >
      <FpsGate limit={paused ? 0 : fpsLimit} />
      <ResumeFrame paused={paused} />
      <FrameMeter />
      <color attach="background" args={['#020308']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[3, 4, 5]} intensity={1.1} />
      <ActivePreset />
    </Canvas>
  )
}
