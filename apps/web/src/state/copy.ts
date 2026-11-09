import { copyText } from '../lib/copy.ts';
import { actions, type UiStore } from './ui.tsx';

export interface CopyOptions {
  /** What was copied, for the toast: `Copied file path`. Without it: `Copied!`. */
  what?: string;
  /** Viewport point to anchor the toast above; otherwise it shows bottom-centre. */
  at?: { x: number; y: number };
  /** The text had invisible / bidirectional characters and was copied escaped. */
  escaped?: boolean;
}

/** Copies `text` and reports the result in the copy toast. Resolves to whether it copied. */
export async function copyAndReport(
  store: UiStore,
  text: string,
  options: CopyOptions = {},
): Promise<boolean> {
  const ok = await copyText(text);
  const note = options.escaped ? ' (invisible characters escaped)' : '';
  actions.copyToast(store, {
    ok,
    text: ok
      ? `${options.what ? `Copied ${options.what}` : 'Copied!'}${note}`
      : 'Failed to copy: the clipboard is not available here',
    ...(options.at ? { at: options.at } : {}),
  });
  return ok;
}

export type CopyFn = (text: string, options?: CopyOptions) => void;
