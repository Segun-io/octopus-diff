import { configure } from '@testing-library/dom';

// `findBy*` / `waitFor` give up after 1 s by default. Lazy components (settings, palette, request
// view, credits) load through a dynamic import that the first test of a worker transforms on the
// fly; on a loaded 4-core CI runner that took over 1 s (PR #3, Node 24). DECISIONS #133.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no layout; the sidebar's virtual list needs sizes (test/layout.ts says how).
import { afterEach } from 'vitest';
import { installLayoutShim, resetSidebarLayout } from './layout.ts';

installLayoutShim();
afterEach(resetSidebarLayout);
