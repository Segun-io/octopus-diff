/**
 * @octopus-diff/daemon — PLACEHOLDER until WS2 lands.
 *
 * WS2 implements `startDaemon` per the `StartDaemon` contract (PLAN §5, §6 WS2).
 */
import type { DaemonHandle, StartDaemon, StartDaemonOptions } from '@octopus-diff/contracts';

export const startDaemon: StartDaemon = async (
  _options?: StartDaemonOptions,
): Promise<DaemonHandle> => {
  throw new Error('daemon is a placeholder until WS2 lands');
};
