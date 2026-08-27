import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from '@/shared/ui/states'

interface Props {
  children: ReactNode
  /** Render alternativo; si no se pasa, se usa el `ErrorState` de suite. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  error: Error | null
}

/**
 * Frontera de error de la app. Evita la pantalla en blanco cuando algo revienta
 * durante el render y ofrece reintento sin recargar toda la sesión.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info.componentStack)
    }
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return <ErrorState error={error} onRetry={this.reset} />
  }
}
