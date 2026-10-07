import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { OrchestratorOptions, RunOutcome, TaskOutcome } from '../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import type { Agent, AgentContext, AgentOutput } from '../src/agents/agent.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { TypedEventBus } from '../src/events/event-bus.js';
import { EvidenceLog } from '../src/events/evidence.js';
import { AppDatabase } from '../src/persistence/database.js';
import { RunRepository } from '../src/persistence/run-repository.js';
import { TaskRepository } from '../src/persistence/task-repository.js';
import { EventRepository } from '../src/persistence/event-repository.js';
import { TaskGraph, createTask } from '../src/graph/task-graph.js';
import { DeterministicIdGenerator, SystemClock } from '../src/core/types.js';
import type { Clock, TaskId } from '../src/core/types.js';
import type { JsonValue } from '../src/core/json.js';
import type { WorkflowEvent } from '../src/events/events.js';

/** Agent whose behaviour is scripted per test. */
class ScriptedAgent implements Agent {
  readonly capabilities = [
    'research',
    'implementation',
    'verification',
    'analysis',
    'general',
  ] as const;
  private failRemaining: number;
  readonly calls: Array<{ taskId: string; attempt: number }> = [];

  constructor(
    readonly name: string,
    private readonly options: {
      failRemaining?: number;
      error?: Error;
      sleepMs?: number;
      onExecute?: (context: AgentContext) => void | Promise<void>;
    } = {},
  ) {
    this.failRemaining = options.failRemaining ?? 0;
  }

  async execute(input: JsonValue, context: AgentContext): Promise<AgentOutput> {
    this.calls.push({ taskId: context.taskId, attempt: context.attempt });
    await this.options.onExecute?.(context);
    if (this.options.sleepMs !== undefined) {
      await context.clock.sleep(this.options.sleepMs);
    }
    if (this.failRemaining > 0) {
      this.failRemaining--;
      throw this.options.error ?? new Error(`${this.name} scripted failure`);
    }
    return { output: { agent: this.name, input }, summary: `${this.name} completed` };
  }
}

/** Agent that only completes when the abort signal fires. */
class AbortableAgent implements Agent {
  readonly name = 'abortable';
  readonly capabilities = ['general'] as const;
  readonly started: string[] = [];

  execute(_input: JsonValue, context: AgentContext): Promise<AgentOutput> {
    this.started.push(context.taskId);
    return new Promise<AgentOutput>((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      context.signal.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      );
    });
  }
}

interface Harness {
  orchestrator: Orchestrator;
  bus: TypedEventBus;
  ids: DeterministicIdGenerator;
  clock: Clock;
  runs: RunRepository;
  tasks: TaskRepository;
  events: EventRepository;
  agents: AgentRegistry;
  register(agent: Agent): void;
  collectEvents(): WorkflowEvent[];
}

function setup(options?: OrchestratorOptions & { clock?: Clock }): Harness {
  const db = new AppDatabase(':memory:');
  const bus = new TypedEventBus();
  const ids = new DeterministicIdGenerator();
  const clock = options?.clock ?? new SystemClock();
  const runs = new RunRepository(db.db);
  const tasks = new TaskRepository(db.db);
  const events = new EventRepository(db.db);
  bus.onAny((event) => {
    events.append(event);
  });
  const evidence = new EvidenceLog(bus, ids, clock);
  const agents = new AgentRegistry();
  const tools = new ToolRegistry();
  const orchestrator = new Orchestrator({
    agents,
    tools,
    bus,
    ids,
    clock,
    runs,
    tasks,
    evidence,
    options,
  });
  const collected: WorkflowEvent[] = [];
  bus.onAny((event) => {
    collected.push(event);
  });
  return {
    orchestrator,
    bus,
    ids,
    clock,
    runs,
    tasks,
    events,
    agents,
    register: (agent: Agent) => agents.register(agent),
    collectEvents: () => collected,
  };
}

function chainGraph(
  ids: DeterministicIdGenerator,
  agentName: string = 'deterministic',
): TaskGraph {
  const graph = new TaskGraph();
  const a = createTask(ids.taskId(), 'alpha', agentName);
  const b = createTask(ids.taskId(), 'beta', agentName, { dependsOn: [a.id] });
  const c = createTask(ids.taskId(), 'gamma', agentName, { dependsOn: [b.id] });
  graph.addTask(a);
  graph.addTask(b);
  graph.addTask(c);
  return graph;
}

describe('Orchestrator', () => {
  it('executes a dependency chain in topological order', async () => {
    const harness = setup({ concurrency: 1 });
    const agent = new ScriptedAgent('deterministic');
    harness.register(agent);
    const graph = chainGraph(harness.ids);

    const outcome = await harness.orchestrator.execute(graph, 'linear-run');

    expect(outcome.status).toBe('succeeded');
    expect(outcome.succeeded).toBe(3);
    expect(outcome.tasks.map((task) => task.taskName)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(outcome.tasks.every((task) => task.status === 'succeeded')).toBe(true);
    // Strictly sequential execution order.
    expect(agent.calls.map((call) => call.taskId)).toEqual(
      graph.tasks.map((task) => task.id),
    );
  });

  it('emits the full lifecycle event sequence', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(new ScriptedAgent('deterministic'));
    const graph = chainGraph(harness.ids);
    const outcome = await harness.orchestrator.execute(graph, 'events-run');

    const types = harness.collectEvents().map((event) => event.type);
    expect(types).toEqual([
      'run.created',
      'task.queued',
      'task.started',
      'task.succeeded',
      'task.queued',
      'task.started',
      'task.succeeded',
      'task.queued',
      'task.started',
      'task.succeeded',
      'run.completed',
    ]);
    // Every event was persisted by the onAny subscriber.
    expect(harness.events.countByRun(outcome.runId)).toBe(types.length);
  });

  it('does not start a task until its dependencies complete', async () => {
    const harness = setup({ concurrency: 2 });
    const log: string[] = [];
    const agent = new ScriptedAgent('deterministic', {
      onExecute: (context) => {
        log.push(`start:${context.taskId}`);
      },
    });
    // Wrap execute to also record completion.
    const original = agent.execute.bind(agent);
    agent.execute = async (input, context) => {
      const result = await original(input, context);
      log.push(`end:${context.taskId}`);
      return result;
    };
    harness.register(agent);
    const graph = chainGraph(harness.ids);

    await harness.orchestrator.execute(graph, 'deps-run');

    const betaStart = log.indexOf(`start:${graph.tasks[1]?.id}`);
    const alphaEnd = log.indexOf(`end:${graph.tasks[0]?.id}`);
    const gammaStart = log.indexOf(`start:${graph.tasks[2]?.id}`);
    const betaEnd = log.indexOf(`end:${graph.tasks[1]?.id}`);
    expect(alphaEnd).toBeGreaterThan(-1);
    expect(betaStart).toBeGreaterThan(alphaEnd);
    expect(gammaStart).toBeGreaterThan(betaEnd);
  });

  it('enforces the concurrency limit', async () => {
    const harness = setup({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const agent = new ScriptedAgent('deterministic', {
      sleepMs: 40,
      onExecute: () => {
        active++;
        maxActive = Math.max(maxActive, active);
      },
    });
    const original = agent.execute.bind(agent);
    agent.execute = async (input, context) => {
      try {
        return await original(input, context);
      } finally {
        active--;
      }
    };
    harness.register(agent);

    const graph = new TaskGraph();
    for (let i = 0; i < 6; i++) {
      graph.addTask(createTask(harness.ids.taskId(), `t${i}`, 'deterministic'));
    }

    const outcome = await harness.orchestrator.execute(graph, 'concurrency-run');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.succeeded).toBe(6);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('retries failed tasks and succeeds on a later attempt', async () => {
    const harness = setup({ concurrency: 1, retryBaseDelayMs: 1 });
    const agent = new ScriptedAgent('deterministic', { failRemaining: 2 });
    harness.register(agent);

    const graph = new TaskGraph();
    graph.addTask(
      createTask(harness.ids.taskId(), 'flaky', 'deterministic', { retries: 2 }),
    );

    const outcome = await harness.orchestrator.execute(graph, 'retry-run');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.tasks[0]?.attempts).toBe(3);
    expect(agent.calls).toHaveLength(3);

    const retries = harness
      .collectEvents()
      .filter((event) => event.type === 'task.retried');
    expect(retries).toHaveLength(2);
    if (retries[0]?.type === 'task.retried') {
      expect(retries[0].payload.attempt).toBe(1);
      expect(retries[0].payload.maxAttempts).toBe(3);
      expect(retries[0].payload.delayMs).toBe(1);
    }
  });

  it('fails a task when retries are exhausted', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(
      new ScriptedAgent('deterministic', {
        failRemaining: 10,
        error: new Error('persistent failure'),
      }),
    );
    const graph = new TaskGraph();
    graph.addTask(
      createTask(harness.ids.taskId(), 'flaky', 'deterministic', { retries: 1 }),
    );

    const outcome = await harness.orchestrator.execute(graph, 'retry-exhausted');
    expect(outcome.status).toBe('failed');
    expect(outcome.failed).toBe(1);
    expect(outcome.tasks[0]?.attempts).toBe(2);
    expect(outcome.tasks[0]?.error).toBe('persistent failure');

    const failedEvents = harness
      .collectEvents()
      .filter((event) => event.type === 'task.failed');
    expect(failedEvents).toHaveLength(1);
    if (failedEvents[0]?.type === 'task.failed') {
      expect(failedEvents[0].payload.error).toBe('persistent failure');
    }
  });

  it('fail-fast cancels pending and running tasks', async () => {
    const harness = setup({ concurrency: 2 });
    const failing = new ScriptedAgent('failing', { failRemaining: 1 });
    const slow = new AbortableAgent();
    harness.register(failing);
    harness.register(slow);

    const graph = new TaskGraph();
    graph.addTask(createTask(harness.ids.taskId(), 'failing', 'failing'));
    graph.addTask(createTask(harness.ids.taskId(), 'slow', 'abortable'));

    const outcome = await harness.orchestrator.execute(graph, 'fail-fast-run');
    expect(outcome.status).toBe('failed');
    expect(outcome.failed).toBe(1);
    expect(outcome.cancelled).toBe(1);
    const byName = new Map(outcome.tasks.map((task) => [task.taskName, task]));
    expect(byName.get('failing')?.status).toBe('failed');
    expect(byName.get('slow')?.status).toBe('cancelled');
  });

  it('cancels a running run on abort', async () => {
    const harness = setup({ concurrency: 1 });
    const fast = new ScriptedAgent('deterministic');
    const abortable = new AbortableAgent();
    harness.register(fast);
    harness.register(abortable);

    // The first task completes quickly; the second is abortable.
    // It starts asynchronously (after `start()` returns), so the
    // subscription below reliably sees its `task.started` event.
    const graph = new TaskGraph();
    const a = createTask(harness.ids.taskId(), 'alpha', 'deterministic');
    const b = createTask(harness.ids.taskId(), 'beta', 'abortable', {
      dependsOn: [a.id],
    });
    const c = createTask(harness.ids.taskId(), 'gamma', 'abortable', {
      dependsOn: [b.id],
    });
    graph.addTask(a);
    graph.addTask(b);
    graph.addTask(c);

    const handle = harness.orchestrator.start(graph, 'cancel-run');
    let outcome: RunOutcome | undefined;
    const promise = handle.promise.then((result) => {
      outcome = result;
    });
    const unsubscribe = harness.bus.on('task.started', (event) => {
      if (event.payload.taskName === 'beta') {
        handle.abort();
      }
    });
    await promise;
    unsubscribe();

    expect(outcome?.status).toBe('cancelled');
    expect(outcome?.succeeded).toBe(1);
    expect(outcome?.cancelled).toBe(2);
    const byName = new Map(outcome?.tasks.map((task) => [task.taskName, task]));
    expect(byName.get('alpha')?.status).toBe('succeeded');
    expect(byName.get('beta')?.status).toBe('cancelled');
    expect(byName.get('gamma')?.status).toBe('cancelled');
    expect(harness.runs.get(outcome?.runId ?? '')?.status).toBe('cancelled');
    // Only beta ever ran on the abortable agent.
    expect(abortable.started).toHaveLength(1);
  });

  it('continues independent tasks and skips downstream failures', async () => {
    const harness = setup({ concurrency: 2, failFast: false });
    harness.register(
      new ScriptedAgent('failing', { failRemaining: 1 }),
    );
    harness.register(new ScriptedAgent('independent'));

    const graph = new TaskGraph();
    const a = createTask(harness.ids.taskId(), 'failing', 'failing');
    const b = createTask(harness.ids.taskId(), 'dependent', 'independent', {
      dependsOn: [a.id],
    });
    const c = createTask(harness.ids.taskId(), 'independent', 'independent');
    graph.addTask(a);
    graph.addTask(b);
    graph.addTask(c);

    const outcome = await harness.orchestrator.execute(graph, 'continue-run');
    expect(outcome.status).toBe('failed');
    expect(outcome.failed).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.succeeded).toBe(1);
    const byName = new Map(outcome.tasks.map((task) => [task.taskName, task]));
    expect(byName.get('dependent')?.status).toBe('skipped');
    expect(byName.get('independent')?.status).toBe('succeeded');

    const skippedEvents = harness
      .collectEvents()
      .filter((event) => event.type === 'task.skipped');
    expect(skippedEvents).toHaveLength(1);
    if (skippedEvents[0]?.type === 'task.skipped') {
      expect(skippedEvents[0].payload.reason).toContain('failing');
    }
  });

  it('enforces per-task timeouts', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(new ScriptedAgent('slow', { sleepMs: 200 }));
    const graph = new TaskGraph();
    graph.addTask(
      createTask(harness.ids.taskId(), 'slow', 'slow', { timeoutMs: 20 }),
    );

    const outcome = await harness.orchestrator.execute(graph, 'timeout-run');
    expect(outcome.status).toBe('failed');
    expect(outcome.tasks[0]?.status).toBe('failed');
    expect(outcome.tasks[0]?.error).toContain('timed out');
  });

  it('fails tasks whose agent is not registered', async () => {
    const harness = setup({ concurrency: 1 });
    const graph = new TaskGraph();
    graph.addTask(
      createTask(harness.ids.taskId(), 'ghosted', 'ghost'),
    );
    const outcome = await harness.orchestrator.execute(graph, 'unknown-agent');
    expect(outcome.status).toBe('failed');
    expect(outcome.tasks[0]?.error).toContain('Agent not registered');
  });

  it('fails tasks whose capability is not supported', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(new ScriptedAgent('deterministic'));
    harness.register(
      new (class implements Agent {
        readonly name = 'limited';
        readonly capabilities = ['research'] as const;
        async execute(): Promise<AgentOutput> {
          return { output: null, summary: 'n/a' };
        }
      })(),
    );
    const graph = new TaskGraph();
    graph.addTask(
      createTask(harness.ids.taskId(), 'mismatched', 'limited', {
        capability: 'verification',
      }),
    );
    const outcome = await harness.orchestrator.execute(graph, 'capability-run');
    expect(outcome.status).toBe('failed');
    expect(outcome.tasks[0]?.error).toContain('capability');
  });

  it('persists task states and outputs to SQLite', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(new ScriptedAgent('deterministic'));
    const graph = chainGraph(harness.ids);
    const outcome = await harness.orchestrator.execute(graph, 'persistence-run');

    const rows = harness.tasks.listByRun(outcome.runId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row?.status).toBe('succeeded');
      expect(row?.attempts).toBe(1);
      expect(row?.startedAt).toBeDefined();
      expect(row?.completedAt).toBeDefined();
      const output = JSON.parse(row?.output ?? 'null') as { agent: string };
      expect(output.agent).toBe('deterministic');
    }
    const runRow = harness.runs.get(outcome.runId);
    expect(runRow?.status).toBe('succeeded');
    expect(runRow?.startedAt).toBeDefined();
    expect(runRow?.completedAt).toBeDefined();
  });

  it('returns per-task outcomes with durations', async () => {
    const harness = setup({ concurrency: 1 });
    harness.register(new ScriptedAgent('deterministic'));
    const graph = chainGraph(harness.ids);
    const outcome = await harness.orchestrator.execute(graph, 'outcomes-run');
    const outcome0 = outcome.tasks[0] as TaskOutcome;
    expect(outcome0.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome0.output).toBeDefined();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects invalid graphs before starting a run', async () => {
    const harness = setup({ concurrency: 1 });
    const graph = new TaskGraph();
    const a = createTask(harness.ids.taskId(), 'a', 'deterministic');
    const b = createTask(harness.ids.taskId(), 'b', 'deterministic', {
      dependsOn: [a.id],
    });
    graph.addTask({ ...a, dependsOn: [b.id] as readonly TaskId[] });
    graph.addTask(b);
    await expect(harness.orchestrator.execute(graph, 'invalid')).rejects.toThrow();
    // No run was persisted.
    expect(harness.runs.list()).toHaveLength(0);
  });
});
