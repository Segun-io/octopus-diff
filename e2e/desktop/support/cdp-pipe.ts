/**
 * A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe` (DECISIONS #510).
 *
 * Why not Playwright's `_electron.launch`: it starts Electron with `--inspect=0
 * --remote-debugging-port=0` and connects through Node's inspector and a TCP DevTools port. The
 * packaged app turns the `EnableNodeCliInspectArguments` fuse off and refuses both switches (an
 * installed app must not open a debugger any local process can reach), so `_electron.launch`
 * cannot drive it. The pipe is Chromium's other DevTools transport: the launching process owns
 * descriptors 3 (commands in) and 4 (replies out), NUL-delimited JSON; nobody else can connect.
 */
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Spawn options' stdio for a child that should get the pipe on fds 3 and 4. */
export const CDP_PIPE_STDIO = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] as const;

interface Waiting {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  method: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export class CdpPipe {
  readonly #out: Writable;
  readonly #waiting = new Map<number, Waiting>();
  #nextId = 0;
  #buffer = '';
  #closed: Error | null = null;

  constructor(child: ChildProcess) {
    const out = child.stdio[3] as Writable | null | undefined;
    const input = child.stdio[4] as Readable | null | undefined;
    if (!out || !input) throw new Error('cdp-pipe: spawn the app with CDP_PIPE_STDIO');
    this.#out = out;
    // A write after the app exited must not crash the test runner.
    out.on('error', () => {});
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.#onData(chunk));
    input.on('close', () => this.#fail(new Error('cdp-pipe: the app closed the DevTools pipe')));
    input.on('error', (error) => this.#fail(error));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let end = this.#buffer.indexOf('\0');
    while (end !== -1) {
      const message = JSON.parse(this.#buffer.slice(0, end)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      this.#buffer = this.#buffer.slice(end + 1);
      end = this.#buffer.indexOf('\0');
      if (message.id === undefined) continue; // an event
      const waiting = this.#waiting.get(message.id);
      if (!waiting) continue;
      this.#waiting.delete(message.id);
      if (message.error) {
        waiting.reject(new Error(`cdp-pipe: ${waiting.method}: ${message.error.message}`));
      } else {
        waiting.resolve(message.result ?? {});
      }
    }
  }

  #fail(error: Error): void {
    this.#closed ??= error;
    for (const waiting of this.#waiting.values()) waiting.reject(error);
    this.#waiting.clear();
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, method });
      this.#out.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  async targets(): Promise<TargetInfo[]> {
    const result = await this.send('Target.getTargets');
    return (result.targetInfos as TargetInfo[]) ?? [];
  }

  /** The first page whose URL matches, attached (waits for it to exist). */
  async page(match: (url: string) => boolean, timeoutMs = 30_000): Promise<CdpPage> {
    const deadline = Date.now() + timeoutMs;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      const pages = (await this.targets()).filter((t) => t.type === 'page');
      seen = pages.map((p) => p.url.slice(0, 60));
      const target = pages.find((t) => match(t.url));
      if (target) {
        const attached = await this.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        return new CdpPage(this, attached.sessionId as string, target.url);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `cdp-pipe: no matching page within ${timeoutMs} ms (pages: ${seen.join(', ')})`,
    );
  }
}

export class CdpPage {
  readonly #cdp: CdpPipe;
  readonly sessionId: string;
  readonly url: string;

  constructor(cdp: CdpPipe, sessionId: string, url: string) {
    this.#cdp = cdp;
    this.sessionId = sessionId;
    this.url = url;
  }

  /** Evaluates `expression` in the page (promises awaited) and returns its JSON value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.#cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    const details = result.exceptionDetails as {
      text?: string;
      exception?: { description?: string };
    };
    if (details) {
      throw new Error(
        `cdp-pipe: evaluate failed: ${details.exception?.description ?? details.text}`,
      );
    }
    return (result.result as { value: T }).value;
  }

  /** Polls `expression` until it returns a truthy value. */
  async waitFor<T = unknown>(expression: string, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate<T>(expression);
        if (value) return value;
        last = value;
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `cdp-pipe: timed out after ${timeoutMs} ms waiting for ${what} (last: ${String(last)})`,
    );
  }

  async screenshot(): Promise<Buffer> {
    const shot = await this.#cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    return Buffer.from(shot.data as string, 'base64');
  }
}
