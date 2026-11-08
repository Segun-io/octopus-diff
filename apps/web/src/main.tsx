import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installTokenBootstrap } from './api/token.ts';
import 'virtual:octopus-themes.css';
import './styles.css';

// Before anything talks to the daemon: move `#token=` into localStorage, strip it from the URL.
installTokenBootstrap();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
