// Unit tests of e2e/desktop/support/diagnostics.ts (the packaged-app suite's timeout diagnostics,
// DECISIONS #593). Here because the e2e vitest config only collects `support/**/*.test.ts`.
import { describe, expect, it } from 'vitest';
import {
  formatDiagnostics,
  htmlText,
  logTails,
  pageUrlForLog,
  redact,
  screenText,
  windowTimeline,
} from '../desktop/support/diagnostics.js';

const TOKEN = 'tok_SECRET_abcdefghijklmnopqrstuvwxyz012345';
const UI = `http://127.0.0.1:7428/?x=1#token=${TOKEN}`;

/** A screen as apps/desktop/src/screens.ts builds it (head, CSP, style, escaped text). */
const SCREEN_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">` +
  '<title>Starting octopus-diff…</title><style>p { color: red; }</style></head><body><main>' +
  '<h1>Starting octopus-diff…</h1><p>Starting the daemon.</p><p>a &lt;b&gt; &amp; &quot;c&quot;</p>' +
  '<div class="spin" role="progressbar"></div>' +
  '<nav><a href="octopus-diff-desktop:retry">Try again</a><a href="x">Show the log</a></nav>' +
  '</main></body></html>';
const SCREEN = `data:text/html;charset=utf-8,${encodeURIComponent(SCREEN_HTML)}`;

describe('pageUrlForLog', () => {
  it('drops the query and the fragment (the token) of a page URL', () => {
    expect(pageUrlForLog(UI)).toBe('http://127.0.0.1:7428/');
    expect(pageUrlForLog(UI)).not.toContain(TOKEN);
  });

  it('names a data: page instead of copying it', () => {
    expect(pageUrlForLog(SCREEN)).toBe('data:text/html;charset=utf-8 (a screen page)');
  });

  it('strips what follows ? or # from what is not a URL', () => {
    expect(pageUrlForLog(`weird#token=${TOKEN}`)).toBe('weird');
  });
});

describe('screenText / htmlText', () => {
  it('the visible text of a screen page, without head, style or markup', () => {
    expect(screenText(SCREEN)).toBe(
      'Starting octopus-diff… | Starting the daemon. | a <b> & "c" | Try again | Show the log',
    );
  });

  it('null for anything that is not an HTML data: URL', () => {
    expect(screenText(UI)).toBeNull();
    expect(screenText('data:text/html;charset=utf-8,%E0%A4%A')).toBeNull();
    expect(htmlText('<script>secret()</script><p>x</p>')).toBe('x');
  });
});

describe('redact', () => {
  it('removes the token and token parameters', () => {
    expect(redact(`a ${TOKEN} b`, [TOKEN])).toBe('a <redacted> b');
    expect(redact('see http://h/#token=abcdef12345 and ?token=zz&x=1', [])).toBe(
      'see http://h/#token=<redacted> and ?token=<redacted>&x=1',
    );
    expect(redact('short', ['ab', null, undefined])).toBe('short');
  });
});

const LOG = [
  '[desktop 2026-11-14T03:05:50.000Z] PATH from the login shell (/bin/zsh)',
  '[desktop 2026-11-14T03:05:50.100Z] started the backend (pid 1, attempt 1)',
  '',
  '  octopus-diff 0.0.0 is running',
  '[desktop 2026-11-14T03:05:51.000Z] backend ready: started http://127.0.0.1:7428 (daemon pid 2, version 0.0.0)',
  '[desktop 2026-11-14T03:05:51.200Z] window: loading the UI (attempt 1 of 3)',
  'daemon: listening',
  '[desktop 2026-11-14T03:06:11.200Z] window: UI load attempt 1 failed (no page within 20000 ms); trying again in 1000 ms',
].join('\n');

describe('logTails / windowTimeline', () => {
  it('splits the app notes from the daemon output, last lines only', () => {
    const tails = logTails(LOG, 2, 1);
    expect(tails.app).toHaveLength(2);
    expect(tails.app[1]).toContain('UI load attempt 1 failed');
    expect(tails.daemon).toEqual(['daemon: listening']);
  });

  it('the window lines with times relative to the first app line', () => {
    expect(windowTimeline(LOG)).toEqual([
      '  +1000 ms backend ready: started http://127.0.0.1:7428 (daemon pid 2, version 0.0.0)',
      '  +1200 ms window: loading the UI (attempt 1 of 3)',
      ' +21200 ms window: UI load attempt 1 failed (no page within 20000 ms); trying again in 1000 ms',
    ]);
  });
});

describe('formatDiagnostics', () => {
  it('has the page, the screen text, the log tails and the output, and never the token', () => {
    const text = formatDiagnostics({
      pages: [
        {
          url: SCREEN,
          state: { readyState: 'complete', visibilityState: 'hidden', appReady: null },
        },
        {
          url: UI,
          state: { appReady: 'false', text: `Loading… ${TOKEN}` },
        },
        { url: 'about:blank', probeError: 'Runtime.evaluate: no answer within 3000 ms' },
      ],
      log: `${LOG}\n[desktop 2026-11-14T03:06:12.000Z] oops #token=${TOKEN}`,
      output: `chromium says ${TOKEN}\n`,
      secrets: [TOKEN],
      appAlive: true,
    });
    expect(text).toContain('app process alive: true');
    expect(text).toContain('page 1: data:text/html;charset=utf-8 (a screen page)');
    expect(text).toContain('screen text: Starting octopus-diff… | Starting the daemon.');
    expect(text).toContain('visibilityState=hidden');
    expect(text).toContain('page 2: http://127.0.0.1:7428/');
    expect(text).toContain('app data-ready=false');
    expect(text).toContain('visible text: Loading… <redacted>');
    expect(text).toContain('the page did not answer: Runtime.evaluate');
    expect(text).toContain('window: UI load attempt 1 failed');
    expect(text).toContain('daemon: listening');
    expect(text).toContain('chromium says <redacted>');
    expect(text).not.toContain(TOKEN);
  });

  it('says so when the pages could not be listed', () => {
    const text = formatDiagnostics({
      pages: { error: 'pipe closed' },
      log: '',
      output: '',
      secrets: [],
    });
    expect(text).toContain('pages: could not list them (pipe closed)');
    expect(text).toContain('(none)');
  });
});
