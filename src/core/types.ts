import { randomUUID } from 'node:crypto';

/**
 * Strongly typed, branded identifiers. Branded types prevent accidentally
 * passing a TaskId where a RunId is expected, while remaining plain
 * strings at persistence boundaries.
 */
export type TaskId = string & { readonly __brand: 'TaskId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type EvidenceId = string & { readonly __brand: 'EvidenceId' };

/** Generates the identifiers used across a run. */
export interface IdGenerator {
  taskId(): TaskId;
  runId(): RunId;
  eventId(): EventId;
  evidenceId(): EvidenceId;
}

/**
 * Sequential, reproducible identifiers (e.g. `task-000001`).
 * An optional `prefix` namespaces identifiers, which lets tests
 * and demos run multiple deterministic generators side by side
 * without collisions.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  constructor(private readonly prefix: string = '') {}

  private next(kind: string): string {
    const key = kind;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    const id = `${kind}-${String(n).padStart(6, '0')}`;
    return this.prefix === '' ? id : `${this.prefix}:${id}`;
  }

  taskId(): TaskId {
    return this.next('task') as TaskId;
  }

  runId(): RunId {
    return this.next('run') as RunId;
  }

  eventId(): EventId {
    return this.next('event') as EventId;
  }

  evidenceId(): EvidenceId {
    return this.next('evidence') as EvidenceId;
  }
}

/** Random UUID-based identifiers for production runs. */
export class RandomIdGenerator implements IdGenerator {
  taskId(): TaskId {
    return `task-${randomUUID()}` as TaskId;
  }

  runId(): RunId {
    return `run-${randomUUID()}` as RunId;
  }

  eventId(): EventId {
    return `event-${randomUUID()}` as EventId;
  }

  evidenceId(): EvidenceId {
    return `evidence-${randomUUID()}` as EvidenceId;
  }
}

/**
 * Clock abstraction. All time in the system flows through this interface so
 * tests can substitute a controllable clock for reproducible behaviour.
 */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number;
  /** Asynchronously wait for `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** Wall-clock implementation backed by `Date` and `setTimeout`. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Deterministic clock for tests. `sleep` resolves immediately (tests never
 * actually wait); time only moves when the test calls `advance`.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: number = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Move the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  async sleep(_ms: number): Promise<void> {
    // Intentionally instant: tests control time explicitly via advance().
  }
}
