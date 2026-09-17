import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Last-resort containment for everything outside the canvas (transport, lyrics,
 * panels, menus). SceneErrorBoundary keeps a bad preset from taking the app
 * down; without this one, a throw in any other render path still leaves a blank
 * page with no way back. Recovery is a reload: after a failed render the tree is
 * not worth trusting.
 */
export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App crashed, contained by boundary:', error, info.componentStack)
  }

  private handleReload = () => window.location.reload()

  render() {
    if (this.state.error) {
      return (
        <div className="app-error-fallback" role="alert">
          <p className="scene-error-text">wavi hit an unexpected error.</p>
          <button type="button" className="xp-btn primary" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
