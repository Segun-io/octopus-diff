import {
  type ApiClient,
  ApiClientError,
  parseServerEvent,
  SERVER_EVENT_TYPES,
  type ServerEvent,
} from '@octopus-diff/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { actions, type UiStore, useUi, useUiStore } from '../state/ui.tsx';
import {
  applyReviewToCaches,
  collectEventEffects,
  emptyEffects,
  flushEffects,
  type ReviewPatch,
} from './cache.ts';
import { useApi } from './queries.ts';

/** Batch window for SSE-driven invalidation (coalesces bursts across many worktrees). */
export const EVENT_BATCH_MS = 60;

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
}

/** Test seam only: production uses the contract client's fetch-based `subscribe`. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/**
 * Subscribes to `/api/events` with the contract client's fetch-based `subscribe`, which sends
 * the bearer token (auth v2: `EventSource` cannot send headers and there is no cookie), and
 * invalidates the query cache precisely. It reconnects with backoff; every (re)connect starts
 * with a `hello` event. `factory` replaces the transport in tests.
 */
export function useServerEvents(factory: EventSourceFactory | null = null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const store = useUiStore();

  useEffect(() => {
    let effects = emptyEffects();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFlush = 0;
    let helloCount = 0;
    const flush = () => {
      timer = undefined;
      lastFlush = Date.now();
      const batch = effects;
      effects = emptyEffects();
      void flushEffects(queryClient, batch, api);
    };
    const handle = (event: ServerEvent) => {
      if (event.type === 'hello') helloCount++;
      if (event.type === 'scan.progress') {
        store.setState({
          scan: {
            scanRootId: event.scanRootId,
            state: event.state,
            scannedDirs: event.scannedDirs,
            foundRepos: event.foundRepos,
            message: event.message,
          },
        });
      }
      collectEventEffects(queryClient, event, effects, { reconnect: helloCount > 1 });
      if (timer === undefined) {
        // After a quiet period, flush on the next tick (one event after an edit is the common
        // case); within EVENT_BATCH_MS of the last flush, batch (bursts across many worktrees).
        const quiet = Date.now() - lastFlush >= EVENT_BATCH_MS;
        timer = setTimeout(flush, quiet ? 0 : EVENT_BATCH_MS);
      }
    };

    store.setState({ connection: 'connecting' });
    let close: () => void;
    if (factory) {
      const source = factory(api.eventsUrl());
      source.onopen = () => store.setState({ connection: 'open' });
      source.onerror = () => store.setState({ connection: 'offline' });
      for (const type of SERVER_EVENT_TYPES) {
        source.addEventListener(type, (message) => {
          const event = parseServerEvent({ data: String(message.data) });
          if (event) handle(event);
        });
      }
      close = () => source.close();
    } else {
      const sub = subscribeViaFetch(api, store, handle);
      close = () => sub.close();
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      close();
    };
  }, [api, queryClient, store, factory]);
}

function subscribeViaFetch(api: ApiClient, store: UiStore, handle: (event: ServerEvent) => void) {
  const sub = api.subscribe({
    onEvent: handle,
    onOpen: () => store.setState({ connection: 'open' }),
    onError: (error) => {
      store.setState({ connection: 'offline' });
      // Retrying with the same (missing or wrong) token cannot succeed; the projects query shows
      // the "not authorized" state, and opening the printed URL reloads the page.
      if (error instanceof ApiClientError && error.code === 'unauthorized') sub.close();
    },
  });
  return sub;
}

/** Marks a file reviewed/unreviewed with an optimistic cache update and rollback on error. */
export function useReviewMutation() {
  const api = useApi();
  const queryClient = useQueryClient();
  const store = useUiStore();
  return useMutation({
    mutationFn: (patch: ReviewPatch) =>
      api.setReview({
        projectId: patch.projectId,
        scopeKind: patch.scopeKind,
        path: patch.path,
        ...(patch.rawPath ? { rawPath: patch.rawPath } : {}),
        patchHash: patch.patchHash,
        reviewed: patch.reviewed,
      }),
    onMutate: (patch) => ({ rollback: applyReviewToCaches(queryClient, patch) }),
    onError: (_error, _patch, context) => {
      context?.rollback();
      actions.notice(store, 'Could not save the review mark; reverted.');
    },
    onSuccess: () => {
      // A refetch that started before the PUT may have overwritten the optimistic value.
      for (const prefix of [['inbox'], ['files'], ['diff']]) {
        if (queryClient.isFetching({ queryKey: prefix }) > 0) {
          void queryClient.invalidateQueries({ queryKey: prefix });
        }
      }
    },
  });
}

/** Tells the daemon which worktree is focused (null when the tab is hidden). */
export function useFocusReporting(worktreeId: string | null) {
  const api = useApi();
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const next = hidden ? null : worktreeId;
      if (next === last.current) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        last.current = next;
        api.setFocus({ worktreeId: next }).catch(() => {
          last.current = undefined;
        });
      }, 250);
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', report);
    };
  }, [api, worktreeId]);
}

/** Resolved theme: follows prefers-color-scheme unless overridden. */
export function useResolvedTheme(): 'light' | 'dark' {
  const pref = useUi((s) => s.theme.mode);
  const systemDark = useSystemDark();
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemDark(onChange: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {};
  const mq = matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSystemDark(): boolean {
  return typeof matchMedia === 'undefined' ? true : matchMedia(DARK_QUERY).matches;
}

function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeSystemDark, getSystemDark, () => true);
}
