import React from 'react';
import ReactDOM from 'react-dom/client';
import { loadSettings } from './lib/storage';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error) return <CrashScreen error={this.state.error} />;
    return this.props.children;
  }
}

/**
 * The one screen that renders when everything else has failed (R-G19: its
 * heading and its stringified error sit at `risk-high` on `risk-high-tint`,
 * never at `ink-4` or below).
 *
 * Extracted from `ErrorBoundary`'s own `render` because it is now needed by
 * something a React boundary cannot see: a module that throws while it is
 * being EVALUATED, before any component exists to catch it — see below.
 */
function CrashScreen({ error }: { error: unknown }) {
  return (
    <div className="p-10 min-h-screen bg-paper text-ink-1">
      <h1 className="font-prose text-screen-title text-risk-high mb-4">Something went wrong.</h1>
      <pre className="bg-risk-high-tint border border-risk-high-edge text-risk-high p-4 rounded-card overflow-auto font-mono text-ui-sm">
        {String(error)}
      </pre>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find #root to mount to');
const root = ReactDOM.createRoot(rootElement);

// PURGED HERE, ahead of the sign-in gate, not inside it.
//
// `loadSettings` deletes any OpenRouter key an earlier version of the app
// stored, and `storage.ts` explains why that is the one deliberate deletion
// in this project. Its only other caller is `AppShell`'s `useState`
// initializer — and `App` renders `SignInScreen` INSTEAD OF `AppShell` for
// every status but `signed-in`, so a user who cannot sign in (a broken
// issuer, an account without the app role) kept a live credential in
// `localStorage` indefinitely, in a browser that no longer has any code
// that could use it. Stage 1's definition of done is that no OpenRouter key
// exists in ANY browser; that sentence is only true if the purge runs for
// everyone who opens the app, which is here. `AppShell` still calls it for
// its settings; the second read finds nothing left to delete, and the
// session latch (`apiKeyWasPurgedThisSession`) is what raises the notice.
loadSettings();

// `App` is imported DYNAMICALLY, and this is the whole reason.
//
// `src/lib/config.ts` throws during module evaluation when a `VITE_*` value
// is missing — deliberately, because a missing identity configuration must
// not become an app that runs and mostly works. With a static
// `import App from './App'` at the top of this file, that throw happened
// before `createRoot(...)` ran at all, so the `ErrorBoundary` written to
// report it never mounted: the user got a white screen, and the sentence
// composed for exactly this moment existed only in the console. A blank
// page is indistinguishable from a broken CDN — loud in intent, silent in
// fact. Deferring the import turns the throw into a rejection this file can
// catch and RENDER.
import('./App')
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    root.render(<CrashScreen error={error} />);
  });
