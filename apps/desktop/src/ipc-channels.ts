/**
 * IPC channel names of the `window.octopusDesktop` bridge, shared by the preload (`bridge.ts`) and
 * the main process (`ipc.ts`). No dependencies: the preload bundle stays small.
 */
export const BRIDGE_CHANNELS = {
  pickFolder: 'octopus-desktop:pick-folder',
  revealPath: 'octopus-desktop:reveal-path',
  openPath: 'octopus-desktop:open-path',
  openInEditor: 'octopus-desktop:open-in-editor',
  setBadge: 'octopus-desktop:set-badge',
  copyText: 'octopus-desktop:copy-text',
  /** Renderer → main (`send`): the page subscribed to menu commands (`onCommand`). */
  commandsReady: 'octopus-desktop:commands-ready',
} as const;

/** Main → renderer: a menu command (`DesktopCommand`). */
export const COMMAND_CHANNEL = 'octopus-desktop:command';
