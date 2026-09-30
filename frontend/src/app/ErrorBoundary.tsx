import { Component, type ReactNode } from 'react'
import { Button, Card, EmptyState } from '../design-system'

/**
 * A rendering failure must leave a recovery path instead of a blank workspace,
 * and say what failed, so that someone who meets it can pass it on.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) } }
  render() {
    const { error } = this.state
    if (error) return <main className="auth-service-error"><Card><EmptyState icon="warning" title="This page needs a fresh start" description="We couldn’t display the workspace. Your saved conversations are still available. Reload the page to try again." action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload workspace</Button>} /><details className="error-details"><summary>Technical details</summary><code>{`${error.name}: ${error.message}`}</code></details></Card></main>
    return this.props.children
  }
}
