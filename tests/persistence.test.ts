import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/persistence/database.js';
import { RunRepository } from '../src/persistence/run-repository.js';
import { TaskRepository } from '../src/persistence/task-repository.js';
import { EventRepository } from '../src/persistence/event-repository.js';
import { buildEvent } from '../src/events/events.js';
import type { EventId, RunId, TaskId } from '../src/core/types.js';
import { DeterministicIdGenerator, FakeClock } from '../src/core/types.js';
import { TaskGraph, createTask } from '../src/graph/task-graph.js';
import { RunNotFoundError } from '../src/core/errors.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeDatabase(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-persistence-'));
  tempDirs.push(dir);
  return new AppDatabase(join(dir, 'test.db'));
}

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

describe('AppDatabase', () => {
  it('enables WAL journal mode', () => {
    const db = makeDatabase();
    expect(db.journalMode).toBe('wal');
    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = makeDatabase();
    expect(db.foreignKeys).toBe(1);
    db.close();
  });

  it('records applied migrations', () => {
    const db = makeDatabase();
    const rows = db.db
      .prepare('SELECT version, name FROM schema_migrations')
      .all() as Array<{ version: number; name: string }>;
    expect(rows).toEqual([{ version: 1, name: '0001_init' }]);
    db.close();
  });

  it('is idempotent when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwo-persistence-'));
    tempDirs.push(dir);
    const path = join(dir, 'reopen.db');
    const first = new AppDatabase(path);
    first.close();
    const second = new AppDatabase(path);
    const rows = second.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    second.close();
  });
});

describe('RunRepository', () => {
  it('creates, reads, updates and lists runs', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    runs.create({ id: 'run-000001', name: 'demo', status: 'running', createdAt: T0 });

    const row = runs.get('run-000001');
    expect(row?.id).toBe('run-000001');
    expect(row?.name).toBe('demo');
    expect(row?.status).toBe('running');
    expect(row?.createdAt).toBe(T0);

    runs.updateStatus('run-000001', {
      status: 'succeeded',
      updatedAt: T1,
      startedAt: T0,
      completedAt: T1,
    });
    const updated = runs.get('run-000001');
    expect(updated?.status).toBe('succeeded');
    expect(updated?.startedAt).toBe(T0);
    expect(updated?.completedAt).toBe(T1);

    expect(runs.list()).toHaveLength(1);
    db.close();
  });

  it('returns null for unknown runs and requires existing ones', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    expect(runs.get('run-999999')).toBeNull();
    expect(() => runs.require('run-999999')).toThrow(RunNotFoundError);
    db.close();
  });

  it('records run errors', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    runs.create({ id: 'run-000001', name: 'demo', status: 'running', createdAt: T0 });
    runs.updateStatus('run-000001', {
      status: 'failed',
      updatedAt: T1,
      completedAt: T1,
      error: 'boom',
    });
    expect(runs.get('run-000001')?.error).toBe('boom');
    db.close();
  });
});

describe('TaskRepository', () => {
  it('persists tasks with JSON payloads and outcomes', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    const tasks = new TaskRepository(db.db);
    runs.create({ id: 'run-000001', name: 'demo', status: 'running', createdAt: T0 });

    const graph = new TaskGraph();
    const task = createTask('task-000001' as TaskId, 'research', 'deterministic', {
      capability: 'research',
      input: { topic: 'wal mode' },
      dependsOn: [],
      retries: 1,
    });
    graph.addTask(task);
    tasks.create({ task, runId: 'run-000001', status: 'pending', createdAt: T0 });

    tasks.updateStatus('task-000001' as TaskId, {
      status: 'succeeded',
      updatedAt: T1,
      attempts: 1,
      startedAt: T0,
      completedAt: T1,
      output: { text: 'done' },
    });

    const rows = tasks.listByRun('run-000001');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.taskName).toBe('research');
    expect(row?.agent).toBe('deterministic');
    expect(row?.capability).toBe('research');
    expect(row?.status).toBe('succeeded');
    expect(row?.attempts).toBe(1);
    expect(JSON.parse(row?.input ?? 'null')).toEqual({ topic: 'wal mode' });
    expect(JSON.parse(row?.output ?? 'null')).toEqual({ text: 'done' });
    expect(JSON.parse(row?.dependsOn ?? 'null')).toEqual([]);
    expect(JSON.parse(row?.definition ?? 'null')).toMatchObject({
      name: 'research',
      retries: 1,
    });
    db.close();
  });

  it('isolates tasks by run', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    const tasks = new TaskRepository(db.db);
    runs.create({ id: 'run-000001', name: 'a', status: 'running', createdAt: T0 });
    runs.create({ id: 'run-000002', name: 'b', status: 'running', createdAt: T0 });

    const taskA = createTask('task-000001' as TaskId, 'a', 'deterministic');
    const taskB = createTask('task-000002' as TaskId, 'b', 'deterministic');
    tasks.create({ task: taskA, runId: 'run-000001', status: 'pending', createdAt: T0 });
    tasks.create({ task: taskB, runId: 'run-000002', status: 'pending', createdAt: T0 });

    expect(tasks.listByRun('run-000001')).toHaveLength(1);
    expect(tasks.listByRun('run-000002')).toHaveLength(1);
    expect(tasks.get('task-000002' as TaskId)?.runId).toBe('run-000002');
    db.close();
  });

  it('persists failed task errors', () => {
    const db = makeDatabase();
    const runs = new RunRepository(db.db);
    const tasks = new TaskRepository(db.db);
    runs.create({ id: 'run-000001', name: 'demo', status: 'running', createdAt: T0 });
    const task = createTask('task-000001' as TaskId, 'flaky', 'deterministic', {
      retries: 0,
    });
    tasks.create({ task, runId: 'run-000001', status: 'running', createdAt: T0 });
    tasks.updateStatus('task-000001' as TaskId, {
      status: 'failed',
      updatedAt: T1,
      attempts: 1,
      completedAt: T1,
      error: 'scripted failure',
    });
    const row = tasks.get('task-000001' as TaskId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('scripted failure');
    db.close();
  });
});

describe('EventRepository', () => {
  it('appends events and lists them in append order', () => {
    const db = makeDatabase();
    const events = new EventRepository(db.db);
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock(1_700_000_000_000);

    const e1 = buildEvent(
      'run.created',
      { id: ids.eventId(), runId: 'run-000001' as RunId, occurredAt: clock.now() },
      { runName: 'demo', taskCount: 2 },
    );
    const e2 = buildEvent(
      'task.started',
      {
        id: ids.eventId(),
        runId: 'run-000001' as RunId,
        taskId: 'task-000001' as TaskId,
        occurredAt: clock.now(),
      },
      { taskName: 'research', agent: 'deterministic', attempt: 1 },
    );
    events.append(e1);
    events.append(e2);

    const stored = events.listByRun('run-000001');
    expect(stored).toHaveLength(2);
    expect(stored[0]?.type).toBe('run.created');
    expect(stored[0]?.taskId).toBeUndefined();
    expect(stored[1]?.type).toBe('task.started');
    expect(stored[1]?.taskId).toBe('task-000001');
    // Append order is preserved via the autoincrement sequence.
    expect(stored[1]!.seq).toBeGreaterThan(stored[0]!.seq);

    expect(events.count()).toBe(2);
    expect(events.countByRun('run-000001')).toBe(2);
    expect(events.countByRun('run-000002')).toBe(0);
    db.close();
  });

  it('round-trips JSON payloads losslessly', () => {
    const db = makeDatabase();
    const events = new EventRepository(db.db);
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock();
    const event = buildEvent(
      'evidence.recorded',
      { id: ids.eventId(), runId: 'run-000001' as RunId, occurredAt: clock.now() },
      {
        evidenceId: 'evidence-000001',
        kind: 'completion',
        data: { nested: { values: [1, 2, 3] }, text: 'hello' },
        hash: 'a'.repeat(64),
      },
    );
    events.append(event);
    const stored = events.listByRun('run-000001');
    const payload = stored[0]?.payload as {
      data: { nested: { values: number[] }; text: string };
    };
    expect(payload.data.nested.values).toEqual([1, 2, 3]);
    expect(payload.data.text).toBe('hello');
    db.close();
  });

  it('is append-only: events accumulate and never mutate', () => {
    const db = makeDatabase();
    const events = new EventRepository(db.db);
    const ids = new DeterministicIdGenerator();
    const clock = new FakeClock();
    for (let i = 0; i < 5; i++) {
      events.append(
        buildEvent(
          'task.queued',
          { id: ids.eventId(), runId: 'run-000001' as RunId, occurredAt: clock.now() },
          { taskName: `t${i}`, agent: 'deterministic' },
        ),
      );
    }
    // No update/delete methods exist on the repository; the count
    // only ever grows.
    expect(events.countByRun('run-000001')).toBe(5);
    const all = events.listAll();
    expect(all).toHaveLength(5);
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });
});
