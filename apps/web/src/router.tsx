/**
 * The app's router (docs/DECISIONS.md #459): one route, `/`, whose query parameters carry the
 * selection (`state/urlState.ts`). Code-defined, no file-based generation, no loaders: the shell
 * keeps reading its state from the UI store and `useUrlSync` mirrors the two both ways.
 *
 * The daemon token stays out of it by construction: it lives in the fragment, `api/token.ts`
 * strips it before the router exists, no route reads the hash, and every navigation here sets
 * `search` only (a navigation without an explicit `hash` drops the fragment).
 */
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { parseSearch, stringifySearch, validateSearch } from './state/urlState.ts';

export function createAppRouter(options: { component: () => ReactNode; history?: RouterHistory }) {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    validateSearch,
    component: options.component,
  });
  return createRouter({
    routeTree: root.addChildren([index]),
    history: options.history ?? createBrowserHistory(),
    parseSearch,
    stringifySearch,
    // The root has no other path: anything else (a stale bookmark) renders the app as well.
    defaultNotFoundComponent: options.component,
    // No preloading, no scroll restoration: there is nothing to preload and the app scrolls its own panes.
    defaultPreload: false,
    scrollRestoration: false,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
