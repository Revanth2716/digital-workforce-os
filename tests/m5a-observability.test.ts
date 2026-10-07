/**
 * Observability tests (Milestone 5-A).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/persistence/database.js';
import { ObservabilityRepository } from '../src/persistence/observability-repository.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { MetricRegistry, METRIC_NAMES } from '../src/observability/metrics.js';
import { startSpan, endSpan, aggregateTokenUsage } from '../src/observability/spans.js';
import { instrument } from '../src/observability/instrumentation.js';
import { createComposition } from '../src/index.js';
import type { Composition } from '../src/index.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { TypedEventBus } from '../src/events/event-bus.js';
import { DeterministicIdGenerator, FakeClock } from '../src/core/types.js';
import { CalculatorTool } from '../src/tools/builtin-tools.js';
import { DefaultPolicyGate } from '../src/tools/policy-gate.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { CommitTool } from './helpers/policy-tools.js';
import { createDemoResponses, AI_DEMO_OBJECTIVE } from '../src/orchestrator/ai-demo.js';

const tempDirs: string[] = [];
const compositions: Composition[] = [];

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-m5a-obs-'));
  tempDirs.push(dir);
  const db = new AppDatabase(':memory:');
  const repository = new ObservabilityRepository(db.db);
  const clock = new FakeClock();
  const tracer = new LocalTracer(clock, repository);
  return { dir, db, repository, clock, tracer };
}

function makeComposition(): Composition {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-m5a-obs-run-'));
  tempDirs.push(dir);
  const composition = createComposition({
    dbPath: join(dir, 'obs.db'),
    concurrency: 1,
    llmResponses: createDemoResponses(),
    policy: new PolicyEngine(),
  });
  compositions.push(composition);
  return composition;
}

afterEach(() => {
  for (const composition of compositions.splice(0)) composition.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Observability — spans', () => {
  it('creates a span with an id, name and run id', () => {
    const { tracer, clock } = makeHarness();
    const context = tracer.start({ runId: 'run-1', name: 'workflow.execute' });

    expect(context.spanId).toBeTruthy();
    expect(context.runId).toBe('run-1');
    expect(context.name).toBe('workflow.execute');
    expect(context.kind).toBe('internal');
    expect(context.startedAt).toBe(clock.now());

    clock.advance(25);
    const span = tracer.end(context);
    expect(span.durationMs).toBe(25);
    expect(span.status).toBe('ok');
  });

  it('supports nested spans via parent span id', () => {
    const { tracer } = makeHarness();
    const parent = tracer.start({ runId: 'run-1', name: 'workflow.execute' });
    const child = tracer.start({
      runId: 'run-1',
      name: 'agent.execute',
      parentSpanId: parent.spanId,
      agent: 'researcher',
    });

    expect(child.parentSpanId).toBe(parent.spanId);
    const finished = tracer.end(child);
    expect(finished.parentSpanId).toBe(parent.spanId);
  });

  it('records duration from the injected clock', () => {
    const { tracer, clock } = makeHarness();
    const context = tracer.start({ runId: 'run-1', name: 'op' });
    clock.advance(100);
    expect(tracer.end(context).durationMs).toBe(100);
  });

  it('records status ok on success', () => {
    const { tracer } = makeHarness();
    const span = tracer.end(tracer.start({ runId: 'run-1', name: 'op' }));
    expect(span.status).toBe('ok');
    expect(span.error).toBeUndefined();
  });

  it('records status error and the message on failure', () => {
    const { tracer } = makeHarness();
    const span = tracer.end(tracer.start({ runId: 'run-1', name: 'op' }), {
      error: 'boom',
    });
    expect(span.status).toBe('error');
    expect(span.error).toBe('boom');
  });

  it('records agent, task, model and provider metadata', () => {
    const { tracer } = makeHarness();
    const context = tracer.start({
      runId: 'run-1',
      name: 'agent.execute',
      agent: 'researcher',
      taskId: 'task-1',
      taskName: 'research gaps',
      model: 'deterministic-1',
      provider: 'deterministic',
    });
    const span = tracer.end(context);

    expect(span.agent).toBe('researcher');
    expect(span.taskId).toBe('task-1');
    expect(span.taskName).toBe('research gaps');
    expect(span.model).toBe('deterministic-1');
    expect(span.provider).toBe('deterministic');
  });

  it('records attributes including retries and tool counts', () => {
    const { tracer } = makeHarness();
    const context = tracer.start({
      runId: 'run-1',
      name: 'task.retry',
      attributes: { 'retry.count': 2, 'retry.attempt': 1 },
    });
    const span = tracer.end(context, { attributes: { 'tool.count': 3 } });

    expect(span.attributes['retry.count']).toBe(2);
    expect(span.attributes['tool.count']).toBe(3);
  });

  it('persists spans eagerly so they survive without finalize', () => {
    const { tracer, repository } = makeHarness();
    tracer.end(tracer.start({ runId: 'run-1', name: 'op' }));

    const stored = repository.listSpansByRun('run-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('op');
  });

  it('does not double-write a span', () => {
    const { tracer, repository } = makeHarness();
    const context = tracer.start({ runId: 'run-1', name: 'op' });
    const span = tracer.end(context);
    // Re-ending the same context must not duplicate the row.
    tracer.end(context);

    expect(repository.listSpansByRun('run-1')).toHaveLength(1);
    expect(span.spanId).toBeTruthy();
  });

  it('runs a function inside a span and closes it on success', async () => {
    const { tracer } = makeHarness();
    const result = await tracer.withSpan({ runId: 'run-1', name: 'op' }, async () => 42);

    expect(result).toBe(42);
    expect(tracer.listSpans()[0]?.status).toBe('ok');
  });

  it('closes a span with an error and rethrows', async () => {
    const { tracer } = makeHarness();
    await expect(
      tracer.withSpan({ runId: 'run-1', name: 'op' }, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const span = tracer.listSpans()[0]!;
    expect(span.status).toBe('error');
    expect(span.error).toBe('nope');
  });

  it('exposes OTel-compatible attribute names for token usage', () => {
    const context = startSpan({ runId: 'r', name: 'agent', startedAt: 0 });
    const span = endSpan(context, {
      endedAt: 10,
      tokenUsage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    });

    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(5);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(7);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(12);
  });
});

describe('Observability — token metadata', () => {
  it('keeps unavailable token usage distinct from zero', () => {
    const usage = aggregateTokenUsage([]);
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
  });

  it('reports partial availability as partial', () => {
    const a = endSpan(startSpan({ runId: 'r', name: 'x', startedAt: 0 }), {
      endedAt: 1,
      tokenUsage: { inputTokens: 3, outputTokens: null, totalTokens: null },
    });
    const usage = aggregateTokenUsage([a]);

    expect(usage.inputTokens).toBe(3);
    // Not reported, so not invented as 0.
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
  });

  it('omits token attributes entirely when nothing was reported', () => {
    const span = endSpan(startSpan({ runId: 'r', name: 'x', startedAt: 0 }), { endedAt: 1 });
    expect(span.attributes['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(span.tokenUsage).toBeUndefined();
  });

  it('round-trips token usage through persistence', () => {
    const { tracer, repository } = makeHarness();
    tracer.end(tracer.start({ runId: 'run-1', name: 'agent' }), {
      tokenUsage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });

    const stored = repository.listSpansByRun('run-1')[0]!;
    expect(stored.tokenUsage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    });
  });

  it('persists a span with no usage as undefined, not zeros', () => {
    const { tracer, repository } = makeHarness();
    tracer.end(tracer.start({ runId: 'run-1', name: 'tool' }));

    const stored = repository.listSpansByRun('run-1')[0]!;
    expect(stored.tokenUsage).toBeUndefined();
  });
});

describe('Observability — metrics', () => {
  function spanWith(overrides: Partial<Parameters<typeof startSpan>[0]> & { durationMs?: number }) {
    const context = startSpan({ runId: 'r', name: 'op', startedAt: 0, ...overrides });
    return endSpan(context, { endedAt: overrides.durationMs ?? 10 });
  }

  it('counts tool calls and tool errors', () => {
    const metrics = MetricRegistry.fromSpans([
      { ...spanWith({ name: 'tool.call' }), status: 'ok' },
      { ...spanWith({ name: 'tool.call' }), status: 'error', error: 'failed' },
    ]);
    const byName = new Map(metrics.map((m) => [m.name, m.value]));

    expect(byName.get(METRIC_NAMES.toolCalls)).toBe(2);
    expect(byName.get(METRIC_NAMES.toolErrors)).toBe(1);
    expect(byName.get(METRIC_NAMES.errors)).toBe(1);
  });

  it('counts each retry event once, without double counting', () => {
    const metrics = MetricRegistry.fromSpans([
      // A task.retry span represents one retry; its retry.count
      // attribute must not add a second count.
      { ...spanWith({ name: 'task.retry', attributes: { 'retry.count': 2 } }) },
    ]);
    const byName = new Map(metrics.map((m) => [m.name, m.value]));
    expect(byName.get(METRIC_NAMES.retries)).toBe(1);
  });

  it('reads retry counts from non-retry spans', () => {
    const metrics = MetricRegistry.fromSpans([
      { ...spanWith({ name: 'task.execute', attributes: { 'retry.count': 3 } }) },
    ]);
    const byName = new Map(metrics.map((m) => [m.name, m.value]));
    expect(byName.get(METRIC_NAMES.retries)).toBe(3);
  });

  it('sums agent durations', () => {
    const metrics = MetricRegistry.fromSpans([
      { ...spanWith({ name: 'agent.execute', durationMs: 100 }) },
      { ...spanWith({ name: 'agent.execute', durationMs: 50 }) },
    ]);
    const byName = new Map(metrics.map((m) => [m.name, m.value]));
    expect(byName.get(METRIC_NAMES.agentDuration)).toBe(150);
  });

  it('reports run duration from the workflow span', () => {
    const metrics = MetricRegistry.fromSpans([
      { ...spanWith({ name: 'workflow.execute', durationMs: 500 }) },
    ]);
    const byName = new Map(metrics.map((m) => [m.name, m.value]));
    expect(byName.get(METRIC_NAMES.runDuration)).toBe(500);
    expect(byName.get(METRIC_NAMES.runCount)).toBe(1);
  });

  it('omits token metrics when no provider reported usage', () => {
    const metrics = MetricRegistry.fromSpans([spanWith({ name: 'tool.call' })]);
    const names = metrics.map((m) => m.name);
    expect(names).not.toContain(METRIC_NAMES.totalTokens);
  });

  it('is deterministic', () => {
    const spans = [
      { ...spanWith({ name: 'tool.call' }) },
      { ...spanWith({ name: 'agent.execute', durationMs: 7 }) },
    ];
    expect(MetricRegistry.fromSpans(spans)).toEqual(MetricRegistry.fromSpans(spans));
  });

  it('accumulates metrics in the repository', () => {
    const { repository } = makeHarness();
    repository.mergeMetrics('run-1', [
      { name: 'a', value: 2, count: 1, updatedAt: 0 },
    ]);
    repository.mergeMetrics('run-1', [
      { name: 'a', value: 3, count: 1, updatedAt: 0 },
    ]);

    const stored = repository.listMetricsByRun('run-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe(5);
    expect(stored[0]?.count).toBe(2);
  });
});

describe('Observability — instrumentation', () => {
  it('turns agent lifecycle evidence into spans', async () => {
    const composition = makeComposition();
    await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const runId = composition.runs.list()[0]?.id ?? '';
    const allSpans = composition.observability
      .listMetricsByRun(runId)
      .map(() => undefined)
      .filter(() => false);
    expect(allSpans).toEqual([]);

    // Spans exist for the run's scope.
    const spans = composition.runService.getSpans(
      composition.runService.listRuns()[0]!.id,
    );
    expect(spans.some((span) => span.name === 'agent.execute')).toBe(true);
    expect(spans.some((span) => span.agent !== undefined)).toBe(true);
  });

  it('records tool call spans from tool evidence', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const spans = composition.runService.getSpans(result.runId);
    const toolSpans = spans.filter((span) => span.name === 'tool.call');
    expect(toolSpans.length).toBeGreaterThan(0);
    // Each tool span has a duration and an ok attribute.
    for (const span of toolSpans) {
      expect(span.durationMs).not.toBeUndefined();
      expect(typeof span.attributes['tool.ok']).toBe('boolean');
    }
  });

  it('records verification and repair spans', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const spans = composition.runService.getSpans(result.runId);
    expect(spans.some((span) => span.name === 'verification')).toBe(true);
    expect(spans.some((span) => span.name === 'workflow.repair')).toBe(true);
  });

  it('records policy decision spans', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const spans = composition.runService.getSpans(result.runId);
    // Tool policy decisions are audited through the registry.
    expect(spans.some((span) => span.name.startsWith('policy.'))).toBe(true);
  });

  it('produces run metrics for an executed workflow', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const metrics = composition.runService.getMetrics(result.runId);
    expect(metrics.durationMs).not.toBeNull();
    expect(metrics.toolCallCount).toBeGreaterThan(0);
    expect(metrics.agentDurationMs).not.toBeNull();
    expect(metrics.repairCount).toBe(1);
  });

  it('stops observing after dispose', async () => {
    const composition = makeComposition();
    composition.instrumentation.dispose();
    await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const spans = composition.runService.getSpans(
      composition.runService.listRuns()[0]!.id,
    );
    // No instrumentation spans were produced after disposal.
    expect(spans).toEqual([]);
  });

  it('records a denial span when policy blocks a tool', async () => {
    const db = new AppDatabase(':memory:');
    const repository = new ObservabilityRepository(db.db);
    const clock = new FakeClock();
    const tracer = new LocalTracer(clock, repository);
    const bus = new TypedEventBus();
    const tools = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    tools.register(new CommitTool());

    const handle = instrument({ bus, tracer, clock, tools });
    try {
      await tools.execute('git.commit', { message: 'x' }, { clock }).catch(() => undefined);
      const spans = tracer.listSpans().filter((span) => span.name === 'policy.denial');
      expect(spans.length).toBe(1);
      expect(spans[0]?.attributes['policy.allowed']).toBe(false);
    } finally {
      handle.dispose();
      db.close();
    }
  });
});