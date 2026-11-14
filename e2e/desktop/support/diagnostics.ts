/**
 * What a window wait that timed out puts in its error (DECISIONS #593), so a CI log alone says what
 * the window was doing: each page's URL without its query and fragment (the UI's fragment holds the
 * token), the visible text of a screen page (decoded from its `data:` URL) or of the web UI, the
 * app's own log lines (`[desktop …]`) and the daemon's last lines from `daemon.log`, and the tail of
 * the app's stdout/stderr. Everything passes through `redact` first. Pure: the gathering is in
 * packaged-app.ts (`windowDiagnostics`).
 */

/** A page URL for a log: no query, no fragment; a `data:` page is named, not copied. */
export function pageUrlForLog(url: string): string {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    return `${comma === -1 ? 'data:' : url.slice(0, comma)} (a screen page)`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.replace(/[?#].*$/s, '');
  }
}

/** The text a user sees on one of the app's screens (`data:text/html,…`): title, paragraphs, links. */
export function screenText(dataUrl: string): string | null {
  if (!dataUrl.startsWith('data:text/html')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  let html: string;
  try {
    html = decodeURIComponent(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
  return htmlText(html);
}

/** Visible text of an HTML document: no `<head>`, `<style>` or `<script>`, tags dropped. */
export function htmlText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(h\d|p|pre|div|nav|a|li)>/gi, ' | ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/(\s*\|\s*)+/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim();
}

/** Removes the token (and anything shaped like a token parameter) from text that goes into a log. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('<redacted>');
  }
  return out.replace(/([#?&]token=)[^&\s'"#]+/g, '$1<redacted>');
}

export interface LogTails {
  /** The app's own lines (`[desktop <time>] …`). */
  app: string[];
  /** Everything else in daemon.log: the daemon's stdout/stderr. */
  daemon: string[];
}

/** The last lines of daemon.log, split into the app's notes and the daemon's own output. */
export function logTails(log: string, appLines = 40, daemonLines = 25): LogTails {
  const lines = log.split('\n').filter((l) => l.trim() !== '');
  const app = lines.filter((l) => l.startsWith('[desktop '));
  const daemon = lines.filter((l) => !l.startsWith('[desktop '));
  return { app: app.slice(-appLines), daemon: daemon.slice(-daemonLines) };
}

/** The app's window lifecycle lines (`window: …`, `app: …`) with times relative to the first line. */
export function windowTimeline(log: string): string[] {
  const lines = log.split('\n').filter((l) => l.startsWith('[desktop '));
  const first = lines[0] ? lineTime(lines[0]) : null;
  return lines
    .filter((l) => /\] (window|app): |backend ready|could not load the UI/.test(l))
    .map((l) => {
      const t = lineTime(l);
      const rel = first !== null && t !== null ? `+${t - first} ms` : '?';
      return `${rel.padStart(10)} ${l.replace(/^\[desktop [^\]]*\] /, '')}`;
    });
}

function lineTime(line: string): number | null {
  const m = /^\[desktop ([^\]]+)\]/.exec(line);
  const t = m?.[1] ? Date.parse(m[1]) : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

export interface PageProbe {
  url: string;
  /** From the page itself (CDP), when it answered. */
  state?: {
    readyState?: string;
    visibilityState?: string;
    hasFocus?: boolean;
    appReady?: string | null;
    text?: string;
  };
  probeError?: string;
}

export interface DiagnosticsInput {
  pages: PageProbe[] | { error: string };
  log: string;
  output: string;
  secrets: readonly (string | null | undefined)[];
  appAlive?: boolean;
}

/** The block appended to a timed-out window wait's error message. */
export function formatDiagnostics(input: DiagnosticsInput): string {
  const out: string[] = ['--- window diagnostics ---'];
  if (input.appAlive !== undefined) out.push(`app process alive: ${input.appAlive}`);
  if ('error' in input.pages) {
    out.push(`pages: could not list them (${input.pages.error})`);
  } else if (input.pages.length === 0) {
    out.push('pages: none');
  } else {
    for (const [i, page] of input.pages.entries()) {
      out.push(`page ${i + 1}: ${pageUrlForLog(page.url)}`);
      const screen = screenText(page.url);
      if (screen !== null) out.push(`  screen text: ${screen.slice(0, 600)}`);
      if (page.state) {
        const s = page.state;
        out.push(
          `  document: readyState=${s.readyState}, visibilityState=${s.visibilityState}, ` +
            `hasFocus=${s.hasFocus}, app data-ready=${s.appReady ?? '(no app element)'}`,
        );
        if (screen === null && s.text) {
          out.push(`  visible text: ${s.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
        }
      }
      if (page.probeError) out.push(`  (the page did not answer: ${page.probeError})`);
    }
  }
  const tails = logTails(input.log);
  out.push(`app log (the last ${tails.app.length} [desktop] lines of daemon.log):`);
  out.push(...(tails.app.length > 0 ? tails.app.map((l) => `  ${l}`) : ['  (none)']));
  out.push(`daemon output (the last ${tails.daemon.length} lines of daemon.log):`);
  out.push(...(tails.daemon.length > 0 ? tails.daemon.map((l) => `  ${l}`) : ['  (none)']));
  const output = input.output.trim().split('\n').slice(-15);
  out.push('app stdout/stderr (the last 15 lines):');
  out.push(...(output.length > 0 && output[0] !== '' ? output.map((l) => `  ${l}`) : ['  (none)']));
  return redact(out.join('\n'), input.secrets);
}

/**
 * UI load attempts that failed and were retried (`UI load attempt <n> failed …`), from
 * `windowTimeline` lines. The give-up lines (`did not load in`, `could not load the UI`) are not
 * counted again: a launch that gave up never reached the UI anyway.
 */
export function failedUiAttempts(lines: readonly string[]): number {
  return lines.filter((l) => /UI load attempt \d+ failed/.test(l)).length;
}

/** The error a timed-out window wait throws: the original message and stack, redacted, + diagnostics. */
export function wrapWithDiagnostics(
  error: unknown,
  diagnostics: string,
  secrets: readonly (string | null | undefined)[],
): Error {
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  const wrapped = new Error(`${message}\n${diagnostics}`);
  if (error instanceof Error && error.stack) {
    // The frames only: the lines after the first are the rest of a multi-line message just as often
    // (an evaluate exception's description), and the whole stack is redacted again regardless,
    // since a message line can look like a frame.
    const frames = error.stack.split('\n').filter((l) => /^\s+at /.test(l));
    wrapped.stack = redact(`${wrapped.message}\n${frames.join('\n')}`, secrets);
  }
  return wrapped;
}
