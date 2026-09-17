import { useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { useStore } from '../store'
import Mellow2Preset from './presets/Mellow2Preset'
import AuroraSilkPreset from './presets/AuroraSilkPreset'
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
    case 'auroraSilk':
      return <AuroraSilkPreset />
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

export default function Scene() {
  const fpsLimit = useStore((s) => s.fpsLimit)
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 55 }}
      dpr={[1, 1.5]}
      frameloop={fpsLimit > 0 ? 'demand' : 'always'}
      gl={{ antialias: false, powerPreference: 'high-performance', depth: false, stencil: false }}
    >
      <FpsGate limit={fpsLimit} />
      <color attach="background" args={['#020308']} />
      <ambientLight intensity={0.9} />
      <pointLight position={[3, 4, 5]} intensity={1.1} />
      <ActivePreset />
    </Canvas>
  )
}
