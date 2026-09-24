import { Component, type ReactNode } from 'react'
import { Button, Card, EmptyState } from '../design-system'

/** A rendering failure must leave a recovery path instead of a blank workspace. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="auth-service-error"><Card><EmptyState icon="warning" title="This page needs a fresh start" description="We couldn’t display the workspace. Your saved conversations are still available. Reload the page to try again." action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload workspace</Button>} /></Card></main>
    return this.props.children
  }
}
