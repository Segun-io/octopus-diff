/**
 * Menu commands to the web UI (DECISIONS #495 follow-up, #20): a page that subscribed through
 * `window.octopusDesktop.onCommand` (it sent `commands-ready`) gets the command over IPC; any
 * other page (an older web build served by an attached daemon of another version) still gets
 * phase A's constant script (`page-actions.ts`). The subscription is forgotten whenever the page
 * navigates or the window goes.
 */
import type { DesktopCommand } from '@octopus-diff/contracts';

export type CommandRoute =
  | { kind: 'send'; command: DesktopCommand }
  | { kind: 'script'; script: string };

export class PageCommands {
  private readonly ready = new Set<number>();

  markReady(webContentsId: number): void {
    this.ready.add(webContentsId);
  }

  reset(webContentsId: number): void {
    this.ready.delete(webContentsId);
  }

  route(webContentsId: number, command: DesktopCommand, fallbackScript: string): CommandRoute {
    return this.ready.has(webContentsId)
      ? { kind: 'send', command }
      : { kind: 'script', script: fallbackScript };
  }
}
