import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * A render error anywhere in the tree would otherwise leave a blank page with the
 * failure only in the console. This keeps the app on screen and says what broke.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[fulkrum] the interface failed to render', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash-panel">
        <h1>The interface stopped rendering</h1>
        <p>
          Your runs and data are unaffected: this is the browser view only, and the API bridge keeps working. The
          console has the full stack.
        </p>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
