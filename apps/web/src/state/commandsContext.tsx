import { createContext, useContext } from 'react';
import type { Commands } from './commands.ts';

export const CommandsContext = createContext<Commands | null>(null);

export function useCommandsContext(): Commands {
  const commands = useContext(CommandsContext);
  if (!commands) throw new Error('CommandsContext missing');
  return commands;
}
