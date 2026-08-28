import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-10 min-h-screen bg-paper text-ink-1">
          <h1 className="font-prose text-screen-title text-risk-high mb-4">Something went wrong.</h1>
          <pre className="bg-risk-high-tint border border-risk-high-edge text-risk-high p-4 rounded-card overflow-auto font-mono text-ui-sm">
            {String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find #root to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
