import type { ForgeKind } from '@octopus-diff/contracts';
import { useForgesQuery } from './forges.ts';
import { budgetFor, type WaitSource } from '../lib/wait.ts';

/** The budget of the forge host a request belongs to (null while it is fine or unknown). */
export function useHostBudget(host: string | undefined, kind: ForgeKind | undefined) {
  const budgets = useForgesQuery().data?.budgets;
  return budgetFor(budgets, { host, kind });
}

/** `forgeSource` for one request: its kind, and the budget of its host when that is held back. */
export function useForgeWaitSource(
  kind: ForgeKind,
  host: string | undefined,
): Extract<WaitSource, { kind: 'forge' }> {
  const budget = useHostBudget(host, kind);
  return { kind: 'forge', forge: [kind], budget };
}
