/**
 * useResource tests (M5-B).
 *
 * Covers the loading / success / error / refresh state machine,
 * the overlapping-request guard and the stale-response guard.
 *
 * Uses `react-test-renderer`, which runs React without a DOM — far
 * lighter than a full browser simulation and sufficient for a hook.
 */

import { describe, expect, it } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { ApiError, ResponseShapeError } from '../api/client';
import { describeError, errorMessageOf, useResource } from './useResource';
import type { UseResourceResult } from './useResource';

/**
 * Render a hook and expose its latest value, plus an `update` that
 * re-renders with new arguments so dependency changes can be
 * exercised for real.
 */
function renderHook<TArgs, TResult>(
  hook: (args: TArgs) => TResult,
  initialArgs: TArgs,
): {
  result: () => TResult;
  update: (args: TArgs) => Promise<void>;
  unmount: () => void;
} {
  let latest: TResult | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Harness({ args }: { args: TArgs }): null {
    latest = hook(args);
    return null;
  }

  act(() => {
    renderer = create(createElement(Harness, { args: initialArgs }));
  });

  return {
    result: () => {
      if (latest === undefined) throw new Error('hook never rendered');
      return latest;
    },
    update: async (args: TArgs) => {
      await act(async () => {
        renderer?.update(createElement(Harness, { args }));
      });
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

/** A promise plus its resolve/reject handles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useResource — loading and success', () => {
  it('is loading first, then success with the value', async () => {
    const gate = deferred<string>();
    const harness = renderHook<string, UseResourceResult<string>>(
      () => useResource(() => gate.promise, ['a']),
      '',
    );

    expect(harness.result().state.status).toBe('loading');

    await act(async () => {
      gate.resolve('value');
      await gate.promise;
    });

    expect(harness.result().state.status).toBe('success');
    expect(harness.result().state.data).toBe('value');
    harness.unmount();
  });

  it('is idle and does not fetch while disabled', () => {
    let calls = 0;
    const harness = renderHook<string, UseResourceResult<string>>(
      () =>
        useResource(
          () => {
            calls += 1;
            return Promise.resolve('x');
          },
          ['a'],
          { enabled: false },
        ),
      '',
    );

    expect(calls).toBe(0);
    expect(harness.result().state.status).toBe('idle');
    expect(harness.result().state.data).toBeNull();
    harness.unmount();
  });

  it('exposes a non-refreshing result once settled', async () => {
    const harness = renderHook<string, UseResourceResult<string>>(
      () => useResource(() => Promise.resolve('ok'), ['a']),
      '',
    );

    await settle();

    expect(typeof harness.result().refresh).toBe('function');
    expect(harness.result().isRefreshing).toBe(false);
    harness.unmount();
  });
});

describe('useResource — error states', () => {
  it('reports an ApiError message', async () => {
    const gate = deferred<string>();
    const harness = renderHook<string, UseResourceResult<string>>(
      () => useResource(() => gate.promise, ['a']),
      '',
    );

    await act(async () => {
      gate.reject(new ApiError(404, 'run_not_found', 'Run not found: x'));
      await gate.promise.catch(() => undefined);
    });

    expect(harness.result().state.status).toBe('error');
    expect(errorMessageOf(harness.result().state)).toContain('Run not found: x');
    harness.unmount();
  });

  it('keeps previous data visible alongside an error', async () => {
    let attempt = 0;
    const harness = renderHook<string, UseResourceResult<string>>(
      () =>
        useResource(
          () => {
            attempt += 1;
            return attempt === 1
              ? Promise.resolve('first')
              : Promise.reject(new ApiError(500, 'boom', 'server exploded'));
          },
          ['a'],
        ),
      '',
    );

    await settle();
    expect(harness.result().state.data).toBe('first');

    await act(async () => {
      harness.result().refresh();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.result().state.status).toBe('error');
    // Stale data is retained so the panel can show it with a banner.
    expect(harness.result().state.data).toBe('first');
    // The error message is present for the banner.
    expect(errorMessageOf(harness.result().state)).toContain('server exploded');
    harness.unmount();
  });

  it('describes non-ApiError failures', () => {
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError('string failure')).toBe('string failure');
    expect(describeError(new ResponseShapeError('shape', ['a']))).toContain(
      'Unexpected API response',
    );
  });

  it('marks retryable errors distinctly', () => {
    // A retryable failure carries its code so the UI can nudge.
    expect(describeError(new ApiError(0, 'network_error', 'unreachable'))).toContain(
      'code: network_error',
    );
    // A validation failure is not retryable, so no code is appended.
    expect(describeError(new ApiError(422, 'validation_failed', 'bad input'))).toBe('bad input');
  });
});

describe('useResource — refresh', () => {
  it('re-fetches on refresh', async () => {
    let calls = 0;
    const harness = renderHook<string, UseResourceResult<string>>(
      () =>
        useResource(
          () => {
            calls += 1;
            return Promise.resolve(`call-${calls}`);
          },
          ['a'],
        ),
      '',
    );

    await settle();
    expect(calls).toBe(1);

    await act(async () => {
      harness.result().refresh();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toBe(2);
    expect(harness.result().state.data).toBe('call-2');
    harness.unmount();
  });

  it('skips an overlapping request', async () => {
    let calls = 0;
    const gate = deferred<string>();
    const harness = renderHook<string, UseResourceResult<string>>(
      () =>
        useResource(
          () => {
            calls += 1;
            return gate.promise;
          },
          ['a'],
        ),
      '',
    );

    expect(calls).toBe(1);

    // A refresh while the first request is still in flight must not
    // start a second one.
    await act(async () => {
      harness.result().refresh();
      await Promise.resolve();
    });
    expect(calls).toBe(1);

    await act(async () => {
      gate.resolve('done');
      await gate.promise;
    });
    harness.unmount();
  });

  it('ignores a stale response that lands after a newer one', async () => {
    // Selecting a new run forces a fresh request even while the
    // previous one is pending; the older response must then lose.
    const first = deferred<string>();
    let callIndex = 0;

    const harness = renderHook<string, UseResourceResult<string>>(
      (key: string) =>
        useResource(
          () => {
            callIndex += 1;
            return callIndex === 1 ? first.promise : Promise.resolve('second');
          },
          [key],
        ),
      'run-a',
    );

    expect(callIndex).toBe(1);

    // Switch runs: a second request starts, superseding the first.
    await harness.update('run-b');
    await settle();
    expect(callIndex).toBe(2);

    // The newer request resolves first.
    await settle();
    expect(harness.result().state.data).toBe('second');

    // The stale response lands late and must be ignored.
    await act(async () => {
      first.resolve('stale');
      await first.promise;
      await Promise.resolve();
    });

    expect(harness.result().state.data).toBe('second');
    harness.unmount();
  });

  it('re-fetches when the identity changes', async () => {
    let calls = 0;
    const harness = renderHook<string, UseResourceResult<string>>(
      (key: string) =>
        useResource(
          () => {
            calls += 1;
            return Promise.resolve(`${key}-${calls}`);
          },
          [key],
        ),
      'first',
    );

    await settle();
    expect(calls).toBe(1);
    expect(harness.result().state.data).toBe('first-1');

    // Selecting a different run must trigger a fresh fetch.
    await harness.update('second');
    await settle();

    expect(calls).toBe(2);
    expect(harness.result().state.data).toBe('second-2');
    harness.unmount();
  });
});