import React, { type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
// The typeface first: @font-face has to be registered before any rule that
// names the family, or the first paint measures against the fallback and
// reflows when the real metrics arrive.
import "./fonts.css";
// Base design system second, so per-component stylesheets layer on top of it.
import "./App.css";
// Material layer second: it and a component rule have equal specificity, so
// loading it here lets a component overrule one part of a treatment.
import "./components/glass.css";
import "./themeStore";
import App from "./App";
import { config } from "./config";

class AppErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null; componentStack: string }
> {
  state = { error: null as Error | null, componentStack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${config().brand} render error`, error, info);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-crash">
        <div className="app-crash-card">
          <span className="field-label">{config().brand} recovered the window</span>
          <h1>This view stopped rendering.</h1>
          <p>{this.state.error.message}</p>
          {(this.state.error.stack || this.state.componentStack) && (
            <details>
              <summary>Technical details</summary>
              <pre>{this.state.error.stack || this.state.componentStack}</pre>
            </details>
          )}
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload {config().brand}
          </button>
        </div>
      </main>
    );
  }
}

/**
 * Outside Tauri there is no IPC, so `npm run dev` in a plain browser used to
 * hang forever on the loading screen. The dev harness stands in for the whole
 * backend, and must be installed before anything calls invoke() — hence the
 * dynamic import ahead of the first render. The guard is statically false in a
 * production build, so the harness is dropped from the bundle entirely.
 */
async function boot() {
  if (import.meta.env.DEV) {
    const { installDevMock } = await import("./devmock");
    installDevMock();
  }
  const container = document.getElementById("root") as HTMLElement & {
    _hqRoot?: ReactDOM.Root;
  };
  // Vite re-executes this module on hot update, and calling createRoot twice on
  // the same container detaches the first tree — the window goes blank until a
  // full reload. Cache the root on the node and re-render into it instead.
  const root = container._hqRoot ?? (container._hqRoot = ReactDOM.createRoot(container));
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

void boot();
