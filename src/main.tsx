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
        <div className="p-10 min-h-screen bg-red-950 text-white">
          <h1 className="text-2xl font-bold mb-4">Something went wrong.</h1>
          <pre className="bg-black/50 p-4 rounded overflow-auto text-sm">
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
