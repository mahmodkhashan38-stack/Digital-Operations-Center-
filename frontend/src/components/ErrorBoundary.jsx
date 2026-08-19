import { Component } from 'react';

// DOC-69 - "Error & UX Hardening" (task spec section 34). Before this
// ticket, this application had NO top-level React Error Boundary - an
// uncaught render-time error anywhere in the component tree would unmount
// the whole React tree and leave the visitor looking at a blank white
// page, with no explanation and no way to recover short of a manual
// refresh. React error boundaries can only be class components (no Hook
// equivalent exists as of React 18) - this is the one, intentionally
// small exception to this project's otherwise all-functional-component
// convention.
//
// Deliberately NOT a replacement for this project's existing API error
// handling (every page already catches and displays its own fetch/mutation
// errors inline - see services/api.js's `request()` helper) - this only
// ever catches a genuine RENDERING exception (a bug throwing while
// building the UI itself), which is a different, much rarer failure mode.
// Never logs or displays the error's own message/stack to the user (task
// spec: "Do not expose stack traces.").
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  // Intentionally empty beyond the state update above - no console.error/
  // logging call here (task spec section 37: "UX hardening must not
  // introduce debug console logs."). React's own development-mode overlay
  // already surfaces the real error to a developer locally; production
  // builds have no such overlay, matching the "never expose internals to
  // the end user" rule this project applies to backend errors too.
  componentDidCatch() {}

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <section className="page">
          <div className="card auth-card">
            <h1>Something went wrong</h1>
            <p className="auth-subtitle">
              Something went wrong. Please refresh the page. If the problem continues, try signing out and back in.
            </p>
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-block" onClick={this.handleReload}>
                Refresh Page
              </button>
            </div>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
