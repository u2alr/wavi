import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useStore } from '../store'

// The same preset the app opens on, so a reset lands where a fresh load would.
const SAFE_PRESET = 'mellow1'

interface State {
  error: Error | null
}

/**
 * Containment for the WebGL canvas: a shader-compile error or a bad texture
 * in one preset must take down the canvas, never the whole application.
 * Retry resets to a known-good preset so the same throw doesn't re-fire.
 */
export default class SceneErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Scene crashed, contained by boundary:', error, info.componentStack)
  }

  private handleRetry = () => {
    useStore.getState().setCurrentPreset(SAFE_PRESET)
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="scene-error-fallback" role="alert">
          <p className="scene-error-text">The visualizer hit a rendering error.</p>
          <button type="button" className="xp-btn primary" onClick={this.handleRetry}>
            Reset visualizer
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
