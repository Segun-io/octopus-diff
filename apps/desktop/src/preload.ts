/**
 * The sandboxed preload (docs/DESKTOP.md §3.4): exposes `window.octopusDesktop` through
 * `contextBridge`. Written as an ES module, bundled to CommonJS (`scripts/build.mjs` →
 * `dist/preload.cjs`): sandboxed preloads cannot be ES modules, and ESM imports let esbuild drop
 * the unused parts of the contracts (DECISIONS #531). Only `electron`'s renderer modules are used;
 * the bridge itself is `bridge.ts` (unit tested).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createDesktopBridge } from './bridge.js';

/** `navigator.userActivation` (Chromium; not in this package's Node-only type libs). */
interface UserActivationNavigator {
  userActivation?: { isActive: boolean };
}

contextBridge.exposeInMainWorld(
  'octopusDesktop',
  createDesktopBridge({
    platform: process.platform,
    hasUserActivation: () =>
      (navigator as unknown as UserActivationNavigator).userActivation?.isActive === true,
    getPathForFile: (file) => webUtils.getPathForFile(file),
    ipc: {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      send: (channel, ...args) => ipcRenderer.send(channel, ...args),
      on: (channel, listener) => {
        ipcRenderer.on(channel, (event, ...args) => listener(event, ...args));
      },
    },
  }),
);
