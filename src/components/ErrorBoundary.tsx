import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] caught error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-app text-primary gap-4 px-8">
          <div className="w-12 h-12 rounded-full bg-error/20 flex items-center justify-center">
            <span className="text-error text-xl font-bold">!</span>
          </div>
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-tertiary text-center max-w-md">
            An unexpected error occurred. Try refreshing the page.
          </p>
          <pre className="text-xs text-tertiary bg-code p-3 rounded-md max-w-lg overflow-auto max-h-32">
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-md bg-brand-500 text-inverse text-sm hover:bg-brand-600 transition-colors"
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
