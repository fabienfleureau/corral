// A render error used to unmount the whole app and leave a blank page. Keep
// the message on screen so the human can reload or restart the server.

import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Corral render failed", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="render-error" role="alert">
        <div className="render-error-card">
          <h1>Corral could not render this page</h1>
          <p className="inline-error">{error.message}</p>
          <p className="muted">If this started after an update, restart Corral, then reload.</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </section>
    );
  }
}
