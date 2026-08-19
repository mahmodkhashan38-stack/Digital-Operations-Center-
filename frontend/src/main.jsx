import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';

// DOC-69 - "Error & UX Hardening" (task spec section 34). The outermost
// wrapper (above BrowserRouter/App), so it catches a rendering error
// anywhere in the tree - including one thrown by App/AuthProvider
// themselves - not just inside individual routed pages. See
// ErrorBoundary.jsx's own comment for the full rationale.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
