/**
 * The window's requests to the daemon while it is not known to be ours (#22 review LOW 3; docs/
 * DESKTOP.md §11). With the WSL backend, `http://127.0.0.1:<port>` on Windows is whatever answers
 * there: the daemon through WSL's forwarding, or (NAT mode) a program that took the port while the
 * daemon restarted. The web UI reconnects by itself with `Authorization: Bearer <token>`, so from
 * the moment the backend leaves `ready` until `verifyDaemon` proved the daemon at that origin holds
 * the token again, the session cancels every http(s) request of the window (screens are `data:`
 * pages; the main process's own health checks do not go through the session).
 *
 * Inert unless enabled: the default backend (this machine's) never installs the listener. Pure:
 * `install` is `session.webRequest.onBeforeRequest`, injected.
 */
import type { BackendState } from './backend.js';
import { httpOrigin } from './policy.js';

export interface GateSeam {
  /** Install (a function: true = cancel this URL) or remove (null) the request listener. */
  install(listener: ((url: string) => boolean) | null): void;
  /** The first blocked request of a closed spell (for the log: the origin only). */
  blocked?(origin: string): void;
}

export class UiRequestGate {
  readonly #seam: GateSeam;
  #enabled = false;
  #open = false;
  #reported = false;

  constructor(seam: GateSeam) {
    this.#seam = seam;
  }

  /** The WSL backend: install the listener, closed until the next verification. */
  enable(): void {
    this.close();
    if (this.#enabled) return;
    this.#enabled = true;
    this.#seam.install((url) => this.shouldCancel(url));
  }

  /** This machine's backend: remove the listener. */
  disable(): void {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#seam.install(null);
  }

  /** Every state but `ready` closes it; `ready` alone does not open it (only `verified` does). */
  backendState(kind: BackendState['kind']): void {
    if (kind !== 'ready') this.close();
  }

  /** `verifyDaemon` passed for the daemon about to be (re)loaded. */
  verified(): void {
    this.#open = true;
  }

  close(): void {
    this.#open = false;
    this.#reported = false;
  }

  shouldCancel(url: string): boolean {
    if (!this.#enabled || this.#open) return false;
    const origin = httpOrigin(url);
    if (origin === null) return false;
    if (!this.#reported) {
      this.#reported = true;
      this.#seam.blocked?.(origin);
    }
    return true;
  }
}
