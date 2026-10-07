import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposition } from '../src/index.js';
import { TaskGraph, createTask } from '../src/graph/task-graph.js';
import { DeterministicIdGenerator, FakeClock } from '../src/core/types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-e2e-'));
  tempDirs.push(dir);
  return dir;
}

interface DemoTaskIds {
  research: string;
  implementation: string;
  verification: string;
}

function buildWorkflow(ids: DeterministicIdGenerator): { graph: TaskGraph; taskIds: DemoTaskIds } {
  const graph = new TaskGraph();
  const research = createTask(ids.taskId(), 'research', 'deterministic', {
    capability: 'research',
    input: {
      topic: 'SQLite WAL mode',
      tool: 'word_count',
      args: { text: 'write ahead logging enables concurrent readers' },
    },
  });
  const implementation = createTask(ids.taskId(), 'implementation', 'deterministic', {
    capability: 'implementation',
    dependsOn: [research.id],
    input: { topic: 'task graph scheduler' },
  });
  const verification = createTask(ids.taskId(), 'verification', 'deterministic', {
    capability: 'verification',
    dependsOn: [implementation.id],
    input: {
      topic: 'end-to-end correctness',
      tool: 'calculator',
      args: { operation: 'multiply', a: 6, b: 7 },
    },
  });
  graph.addTask(research);
  graph.addTask(implementation);
  graph.addTask(verification);
  return {
    graph,
    taskIds: {
      research: research.id,
      implementation: implementation.id,
      verification: verification.id,
    },
  };
}

describe('end-to-end workflow', () => {
  it('executes research -> implementation -> verification with full persistence', async () => {
    const dir = makeTempDir();
    const composition = createComposition({
      dbPath: join(dir, 'e2e.db'),
      concurrency: 2,
      ids: new DeterministicIdGenerator(),
    });
    try {
      const ids = new DeterministicIdGenerator();
      const { graph } = buildWorkflow(ids);

      const started: string[] = [];
      const succeeded: string[] = [];
      composition.bus.on('task.started', (event) => {
        started.push(event.payload.taskName);
      });
      composition.bus.on('task.succeeded', (event) => {
        succeeded.push(event.payload.taskName);
      });

      const outcome = await composition.orchestrator.execute(graph, 'e2e-run');

      // Run outcome
      expect(outcome.status).toBe('succeeded');
      expect(outcome.succeeded).toBe(3);
      expect(outcome.failed).toBe(0);

      // Dependency-aware ordering
      expect(started).toEqual(['research', 'implementation', 'verification']);
      expect(succeeded).toEqual(['research', 'implementation', 'verification']);

      // Tool results are embedded in task outputs
      const byName = new Map(outcome.tasks.map((task) => [task.taskName, task]));
      const researchOutput = JSON.stringify(byName.get('research')?.output);
      expect(researchOutput).toContain('words');
      const verificationOutput = JSON.stringify(byName.get('verification')?.output);
      expect(verificationOutput).toContain('42');

      // Persistence: run row
      const runRow = composition.runs.get(outcome.runId);
      expect(runRow?.status).toBe('succeeded');
      expect(runRow?.name).toBe('e2e-run');
      expect(runRow?.completedAt).toBeDefined();

      // Persistence: task rows with outputs
      const taskRows = composition.tasks.listByRun(outcome.runId);
      expect(taskRows).toHaveLength(3);
      expect(taskRows.every((row) => row.status === 'succeeded')).toBe(true);
      expect(taskRows.every((row) => row.output !== undefined)).toBe(true);

      // Persistence: event stream
      const eventRows = composition.events.listByRun(outcome.runId);
      const types = eventRows.map((event) => event.type);
      expect(types).toContain('run.created');
      expect(types).toContain('task.queued');
      expect(types).toContain('task.started');
      expect(types).toContain('task.succeeded');
      expect(types).toContain('evidence.recorded');
      expect(types).toContain('run.completed');
      // Sequence numbers are strictly increasing (append order).
      const seqs = eventRows.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

      // Evidence: 2 for research (tool + completion), 1 for implementation,
      // 2 for verification (tool + completion).
      const evidenceEvents = eventRows.filter(
        (event) => event.type === 'evidence.recorded',
      );
      expect(evidenceEvents).toHaveLength(5);
      for (const event of evidenceEvents) {
        const payload = event.payload as { hash: string; kind: string };
        expect(payload.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(['tool.invocation', 'completion']).toContain(payload.kind);
      }
    } finally {
      composition.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps multiple runs isolated in the same database', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'multi.db');
    const first = createComposition({ dbPath, ids: new DeterministicIdGenerator() });
    try {
      const { graph } = buildWorkflow(new DeterministicIdGenerator('one'));
      const outcome = await first.orchestrator.execute(graph, 'run-one');
      expect(outcome.status).toBe('succeeded');
    } finally {
      first.close();
    }
    // Production compositions use random ids, so a second
    // composition can share the database without run-id collisions.
    // The workflow graphs use prefixed deterministic ids so task
    // primary keys stay unique across runs.
    const second = createComposition({ dbPath });
    try {
      const { graph } = buildWorkflow(new DeterministicIdGenerator('two'));
      const outcome = await second.orchestrator.execute(graph, 'run-two');
      expect(outcome.status).toBe('succeeded');

      // Two runs in the database, each with its own tasks and events.
      const runs = second.runs.list();
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.name).sort()).toEqual(['run-one', 'run-two']);
      for (const run of runs) {
        expect(second.tasks.listByRun(run.id)).toHaveLength(3);
        expect(second.events.countByRun(run.id)).toBeGreaterThan(10);
      }
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces reproducible evidence hashes across identical runs', async () => {
    const dir = makeTempDir();
    // Same task graph (identical task ids), fresh compositions with
    // identical id generators and clocks: every input to the evidence
    // hash is therefore identical, so the hashes must match exactly.
    const { graph } = buildWorkflow(new DeterministicIdGenerator());

    const first = createComposition({
      dbPath: join(dir, 'a.db'),
      ids: new DeterministicIdGenerator(),
      clock: new FakeClock(1_700_000_000_000),
    });
    let firstHashes: string[] = [];
    try {
      const outcome = await first.orchestrator.execute(graph, 'repro-run');
      expect(outcome.status).toBe('succeeded');
      firstHashes = first
        .events.listByRun(outcome.runId)
        .filter((event) => event.type === 'evidence.recorded')
        .map((event) => (event.payload as { hash: string }).hash);
      expect(firstHashes.length).toBe(5);
    } finally {
      first.close();
    }

    const second = createComposition({
      dbPath: join(dir, 'b.db'),
      ids: new DeterministicIdGenerator(),
      clock: new FakeClock(1_700_000_000_000),
    });
    try {
      const outcome = await second.orchestrator.execute(graph, 'repro-run');
      expect(outcome.status).toBe('succeeded');
      const secondHashes = second
        .events.listByRun(outcome.runId)
        .filter((event) => event.type === 'evidence.recorded')
        .map((event) => (event.payload as { hash: string }).hash);
      expect(secondHashes).toEqual(firstHashes);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
