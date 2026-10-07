import { describe, expect, it } from 'vitest';
import {
  DeterministicIdGenerator,
  FakeClock,
  RandomIdGenerator,
  SystemClock,
} from '../src/core/types.js';
import type { TaskId } from '../src/core/types.js';
import { DomainError, ValidationError } from '../src/core/errors.js';
import { canonicalJson, hashJson, isJsonObject } from '../src/core/json.js';
import { err, isErr, isOk, mapResult, ok, unwrapOr } from '../src/core/result.js';
import { isTerminalTaskStatus, TASK_STATUSES, RUN_STATUSES } from '../src/core/status.js';

describe('IdGenerator', () => {
  it('deterministic generator produces sequential branded ids', () => {
    const ids = new DeterministicIdGenerator();
    expect(ids.taskId()).toBe('task-000001');
    expect(ids.taskId()).toBe('task-000002');
    expect(ids.runId()).toBe('run-000001');
    expect(ids.eventId()).toBe('event-000001');
    expect(ids.evidenceId()).toBe('evidence-000001');
  });

  it('random generator produces unique prefixed ids', () => {
    const ids = new RandomIdGenerator();
    const taskId = ids.taskId();
    expect(taskId.startsWith('task-')).toBe(true);
    const seen = new Set([taskId, ids.taskId(), ids.runId(), ids.eventId(), ids.evidenceId()]);
    expect(seen.size).toBe(5);
  });

  it('branded ids are plain strings at rest', () => {
    const id: TaskId = new DeterministicIdGenerator().taskId();
    expect(typeof id).toBe('string');
  });
});

describe('Clock', () => {
  it('FakeClock starts at a fixed epoch and advances deterministically', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(5_000);
    expect(clock.now()).toBe(6_000);
  });

  it('FakeClock.sleep resolves instantly without moving time', async () => {
    const clock = new FakeClock(1_000);
    await expect(clock.sleep(10_000)).resolves.toBeUndefined();
    expect(clock.now()).toBe(1_000);
  });

  it('SystemClock returns positive epoch millis', () => {
    expect(new SystemClock().now()).toBeGreaterThan(0);
  });
});

describe('Result', () => {
  it('wraps values and errors', () => {
    const value = ok(42);
    expect(isOk(value)).toBe(true);
    expect(isErr(value)).toBe(false);
    if (isOk(value)) expect(value.value).toBe(42);

    const failure = err(new ValidationError('bad'));
    expect(isErr(failure)).toBe(true);
    if (isErr(failure)) expect(failure.error.message).toBe('bad');
  });

  it('supports unwrapOr and mapResult', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err(new ValidationError('x')), 99)).toBe(99);
    const doubled = mapResult(ok(21), (v) => v * 2);
    expect(isOk(doubled) && doubled.value).toBe(42);
  });
});

describe('canonical JSON', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('handles nested structures and arrays', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe(canonicalJson({ a: [1, { b: 2 }] }));
  });

  it('hashes deterministically and distinctly', () => {
    expect(hashJson({ a: 1 })).toBe(hashJson({ a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });

  it('narrows json objects', () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([1])).toBe(false);
  });
});

describe('status types', () => {
  it('defines the full task lifecycle', () => {
    expect([...TASK_STATUSES]).toEqual([
      'pending',
      'ready',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'skipped',
    ]);
    expect([...RUN_STATUSES]).toEqual(['pending', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('identifies terminal task statuses', () => {
    expect(isTerminalTaskStatus('succeeded')).toBe(true);
    expect(isTerminalTaskStatus('running')).toBe(false);
  });
});

describe('DomainError', () => {
  it('carries code, message, details and cause', () => {
    const cause = new Error('root cause');
    const error = new DomainError('orchestration', 'something broke', { cause, details: { step: 3 } });
    expect(error.code).toBe('orchestration');
    expect(error.message).toBe('something broke');
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ step: 3 });
    expect(error.name).toBe('DomainError');
  });

  it('subclass names and codes are preserved', () => {
    const error = new ValidationError('invalid');
    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe('validation');
  });
});
