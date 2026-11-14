/**
 * The app's own settings (#22): a small JSON file in Electron's userData, next to
 * `window-state.json`. Today it holds one choice, the WSL distro the Windows app runs its backend
 * in (null: the Windows backend, the default). It is never in the daemon's registry or the CLI's
 * config: the daemon inside the distro does not know or care which app started it.
 *
 * Whatever is read back is validated (zod, a strict object, `isSafeDistroName`); anything else is
 * the default, so a broken file means "the Windows backend", never a half-chosen distro.
 */
import { z } from 'zod';
import { isSafeDistroName } from './wsl.js';

export const DESKTOP_SETTINGS_FILE = 'desktop-settings.json';

export const DesktopSettingsSchema = z.strictObject({
  version: z.literal(1),
  wslDistro: z.string().refine(isSafeDistroName).nullable(),
});
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = { version: 1, wslDistro: null };

export function parseDesktopSettings(text: string | null | undefined): DesktopSettings {
  if (!text) return DEFAULT_DESKTOP_SETTINGS;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  const parsed = DesktopSettingsSchema.safeParse(json);
  return parsed.success ? parsed.data : DEFAULT_DESKTOP_SETTINGS;
}

export function serializeDesktopSettings(settings: DesktopSettings): string {
  return `${JSON.stringify(DesktopSettingsSchema.parse(settings), null, 2)}\n`;
}

/** The distro to run the backend in: only on Windows (WSL is inert everywhere else). */
export function wslDistroToUse(
  settings: DesktopSettings,
  platform: NodeJS.Platform,
): string | null {
  return platform === 'win32' ? settings.wslDistro : null;
}

export interface SettingsFs {
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * The settings in memory and on disk, saved **one at a time** (review LOW 4): each save writes a
 * temp file of its own (`<file>.<tag>-<n>.tmp`), renames it over the file, and only then becomes
 * `current`. Two quick choices therefore end with memory and file on the same, last one; a
 * failed save leaves `current` as it was and does not block the next.
 */
export class SettingsStore {
  #current: DesktopSettings;
  #chain: Promise<void> = Promise.resolve();
  #seq = 0;
  readonly #file: string;
  readonly #fs: SettingsFs;
  readonly #tag: string;

  constructor(file: string, initial: DesktopSettings, fs: SettingsFs, tag = String(process.pid)) {
    this.#file = file;
    this.#current = initial;
    this.#fs = fs;
    this.#tag = tag;
  }

  get current(): DesktopSettings {
    return this.#current;
  }

  save(next: DesktopSettings): Promise<void> {
    const text = serializeDesktopSettings(next);
    const run = this.#chain.then(async () => {
      const tmp = `${this.#file}.${this.#tag}-${++this.#seq}.tmp`;
      await this.#fs.writeFile(tmp, text);
      await this.#fs.rename(tmp, this.#file);
      this.#current = next;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
