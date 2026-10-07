/**
 * Data loading hook (M5-B).
 *
 * One hook owns the loading / error / refresh state machine for a
 * single API call, so every panel shares identical behaviour and
 * the rules are testable in isolation.
 *
 * Refresh is simple polling on an interval — no WebSockets, as
 * specified. Polling is paused while the tab is hidden and while a
 * request is already in flight, so a slow backend cannot queue up
 * overlapping requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ResponseShapeError } from '../api/client';

/** The four states a resource can be in. */
export type ResourceState<T> =
  | { readonly status: 'loading'; readonly data: T | null }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly data: T | null; readonly error: string }
  | { readonly status: 'idle'; readonly data: null };

export interface UseResourceOptions {
  /** Poll interval in ms. 0 disables polling. Defaults to 0. */
  readonly pollMs?: number;
  /** Skip fetching entirely (e.g. no run selected yet). */
  readonly enabled?: boolean;
}

/** Human-readable message for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // Retryable failures deserve a nudge; validation ones do not.
    return error.isRetryable
      ? `${error.message} (code: ${error.code})`
      : `${error.message}`;
  }
  if (error instanceof ResponseShapeError) {
    return `Unexpected API response: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface UseResourceResult<T> {
  readonly state: ResourceState<T>;
  /** Re-fetch now. */
  readonly refresh: () => void;
  /** True while a request is in flight. */
  readonly isRefreshing: boolean;
}

/**
 * Narrow a resource state's error message without a cast.
 *
 * `ResourceState` is a discriminated union, so the error only
 * exists on the `error` variant; this makes that narrowing a
 * named, testable helper.
 */
export function errorMessageOf<T>(state: ResourceState<T>): string | undefined {
  return state.status === 'error' ? state.error : undefined;
}

/**
 * Run an async fetcher and expose its state, with optional polling.
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  options: UseResourceOptions = {},
): UseResourceResult<T> {
  const pollMs = options.pollMs ?? 0;
  const enabled = options.enabled ?? true;

  const [state, setState] = useState<ResourceState<T>>({ status: 'idle', data: null });
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Guards against a slow response overwriting a newer one.
  const requestId = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Start a request.
   *
   * `force` is used when the resource's identity changes: a new
   * run must always be fetched, even if the previous run's request
   * is still pending. The request-id guard then makes the older
   * response a no-op instead of overwriting the newer one.
   *
   * Without `force` (manual refresh, polling) an in-flight request
   * is skipped so a slow backend cannot queue up overlapping calls.
   */
  const load = useCallback(
    async (force: boolean) => {
      if (!enabled) return;
      if (inFlight.current && !force) return;

      inFlight.current = true;
      const id = requestId.current + 1;
      requestId.current = id;
      setIsRefreshing(true);

      // Keep the previous data visible while refreshing so the UI
      // does not flash an empty state on every poll.
      setState((previous) =>
        previous.data !== null
          ? { status: 'success', data: previous.data }
          : { status: 'loading', data: null },
      );

      try {
        const data = await fetcherRef.current();
        if (!mounted.current || id !== requestId.current) return;
        setState({ status: 'success', data });
      } catch (error) {
        if (!mounted.current || id !== requestId.current) return;
        // Previous data is retained so the panel can show a stale
        // value alongside the error banner.
        setState((previous) => ({
          status: 'error',
          data: previous.data,
          error: describeError(error),
        }));
      } finally {
        // Only the newest request clears the in-flight flag; an
        // older one finishing must not release a newer request's.
        if (id === requestId.current) {
          inFlight.current = false;
          if (mounted.current) setIsRefreshing(false);
        }
      }
    },
    [enabled],
  );

  // Re-fetch when the identity of the resource changes. Forced, so
  // selecting a new run fetches even if the previous fetch is slow.
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle', data: null });
      return;
    }
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  // Polling.
  useEffect(() => {
    if (!enabled || pollMs <= 0) return undefined;

    const timer = setInterval(() => {
      // Do not poll a hidden tab.
      if (typeof document !== 'undefined' && document.hidden) return;
      void load(false);
    }, pollMs);

    return () => clearInterval(timer);
  }, [enabled, pollMs, load]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  return { state, refresh, isRefreshing };
}