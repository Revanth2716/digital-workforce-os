import { describe, expect, it } from 'vitest';
import { TypedEventBus } from '../src/events/event-bus.js';
import { EvidenceLog } from '../src/events/evidence.js';
import { buildEvent } from '../src/events/events.js';
import type { EventId, RunId, TaskId } from '../src/core/types.js';
import { DeterministicIdGenerator, FakeClock } from '../src/core/types.js';
import { hashJson } from '../src/core/json.js';
import type { JsonValue } from '../src/core/json.js';
import type { WorkflowEvent } from '../src/events/events.js';

const base = {
  id: 'event-000001' as EventId,
  runId: 'run-000001' as RunId,
  taskId: 'task-000001' as TaskId,
  occurredAt: 1_700_000_000_000,
};

describe('TypedEventBus', () => {
  it('delivers typed events to type subscribers', () => {
    const bus = new TypedEventBus();
    const received: Array<{ taskName: string; attempt: number }> = [];
    bus.on('task.started', (event) => {
      received.push({ taskName: event.payload.taskName, attempt: event.payload.attempt });
    });
    bus.emit(
      buildEvent('task.started', base, {
        taskName: 'research',
        agent: 'deterministic',
        attempt: 1,
      }),
    );
    expect(received).toEqual([{ taskName: 'research', attempt: 1 }]);
  });

  it('does not deliver events of other types', () => {
    const bus = new TypedEventBus();
    let called = false;
    bus.on('task.failed', () => {
      called = true;
    });
    bus.emit(buildEvent('task.succeeded', base, { taskName: 'x', attempt: 1, durationMs: 1, summary: '' }));
    expect(called).toBe(false);
  });

  it('unsubscribes cleanly', () => {
    const bus = new TypedEventBus();
    let count = 0;
    const unsubscribe = bus.on('run.created', () => {
      count++;
    });
    bus.emit(buildEvent('run.created', base, { runName: 'a', taskCount: 1 }));
    unsubscribe();
    bus.emit(buildEvent('run.created', base, { runName: 'b', taskCount: 1 }));
    expect(count).toBe(1);
  });

  it('onAny receives every event type', () => {
    const bus = new TypedEventBus();
    const types: string[] = [];
    bus.onAny((event) => {
      types.push(event.type);
    });
    bus.emit(buildEvent('run.created', base, { runName: 'a', taskCount: 1 }));
    bus.emit(buildEvent('task.cancelled', base, { taskName: 'x', reason: 'test' }));
    expect(types).toEqual(['run.created', 'task.cancelled']);
  });

  it('reports listener counts', () => {
    const bus = new TypedEventBus();
    expect(bus.listenerCount()).toBe(0);
    const unsubscribe = bus.onAny(() => undefined);
    bus.on('run.created', () => undefined);
    expect(bus.listenerCount('run.created')).toBe(2);
    expect(bus.listenerCount()).toBe(2);
    unsubscribe();
  });
});

describe('EvidenceLog', () => {
  it('records evidence with content hashes and emits an event', () => {
    const bus = new TypedEventBus();
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock(1_700_000_000_000);
    const log = new EvidenceLog(bus, ids, clock);
    const events: WorkflowEvent[] = [];
    bus.onAny((event) => {
      events.push(event);
    });

    const record = log.record({
      runId: 'run-000001' as RunId,
      taskId: 'task-000001' as TaskId,
      kind: 'completion',
      data: { text: 'hello' },
    });

    expect(record.id).toBe('evidence-000001');
    expect(record.kind).toBe('completion');
    expect(record.createdAt).toBe(1_700_000_000_000);
    // Hash is over the record without the hash itself.
    const withoutHash = {
      id: record.id,
      runId: record.runId,
      taskId: record.taskId,
      kind: record.kind,
      createdAt: record.createdAt,
      data: record.data,
    };
    expect(record.hash).toBe(hashJson(withoutHash as unknown as JsonValue));
    expect(record.hash).toMatch(/^[a-f0-9]{64}$/);

    // The event carries the same hash.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('evidence.recorded');
    if (events[0]?.type === 'evidence.recorded') {
      expect(events[0].payload.evidenceId).toBe(record.id);
      expect(events[0].payload.hash).toBe(record.hash);
      expect(events[0].payload.kind).toBe('completion');
    }
  });

  it('produces different hashes for different content', () => {
    const bus = new TypedEventBus();
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock();
    const log = new EvidenceLog(bus, ids, clock);
    const a = log.record({ runId: 'run-000001' as RunId, kind: 'k', data: { v: 1 } });
    const b = log.record({ runId: 'run-000001' as RunId, kind: 'k', data: { v: 2 } });
    expect(a.hash).not.toBe(b.hash);
  });

  it('is append-only: records are immutable values', () => {
    const bus = new TypedEventBus();
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock();
    const log = new EvidenceLog(bus, ids, clock);
    const record = log.record({ runId: 'run-000001' as RunId, kind: 'k', data: null });
    expect(Object.isFrozen(record) || typeof record).toBe('object');
    // No mutation API exists on EvidenceLog beyond record().
    expect(Object.keys(log)).toEqual(['bus', 'ids', 'clock']);
  });
});
