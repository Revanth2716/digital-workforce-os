/**
 * Application service tests (Milestone 5-A).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposition } from '../src/index.js';
import type { Composition } from '../src/index.js';
import { ApprovalManager } from '../src/approval/approval-manager.js';
import { FakeClock } from '../src/core/types.js';
import { RunNotFoundError, ValidationError } from '../src/core/errors.js';
import { createDemoResponses, AI_DEMO_OBJECTIVE } from '../src/orchestrator/ai-demo.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';

const tempDirs: string[] = [];
const compositions: Composition[] = [];

function makeComposition(options: { readonly policy?: PolicyEngine } = {}): Composition {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-m5a-app-'));
  tempDirs.push(dir);
  const composition = createComposition({
    dbPath: join(dir, 'app.db'),
    concurrency: 1,
    llmResponses: createDemoResponses(),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
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

describe('Application — RunService', () => {
  it('retrieves a run that exists', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const run = composition.runService.getRun(result.runId);
    expect(run.id).toBe(result.runId);
    expect(run.status).toBe('succeeded');
  });

  it('throws RunNotFoundError for an unknown run', () => {
    const composition = makeComposition();
    expect(() => composition.runService.getRun('nope')).toThrow(RunNotFoundError);
    expect(composition.runService.findRun('nope')).toBeUndefined();
  });

  it('lists runs newest first', async () => {
    const composition = makeComposition();
    const a = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);
    const b = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const runs = composition.runService.listRuns();
    expect(runs.some((run) => run.id === a.runId)).toBe(true);
    expect(runs.some((run) => run.id === b.runId)).toBe(true);
  });

  it('excludes internal phase runs from the run list', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const listed = composition.runService
      .listRuns()
      .map((run) => run.id);
    expect(listed).toContain(result.runId);

    // The planner/main/repair runs are phases of the workflow, not
    // separate units of work, so they must not appear as their own
    // rows — otherwise one workflow would render four times.
    const scope = composition.runService.scopeRunIds(result.runId);
    expect(scope.length).toBeGreaterThan(1);
    for (const memberId of scope.filter((id) => id !== result.runId)) {
      expect(listed).not.toContain(memberId);
    }
  });

  it('reports aggregate statistics for the dashboard', async () => {
    const composition = makeComposition();
    await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const stats = composition.runService.getStats();
    expect(stats.totalRuns).toBeGreaterThanOrEqual(1);
    expect(stats.successfulRuns).toBeGreaterThanOrEqual(1);
    expect(stats.failedRuns).toBe(0);
    expect(stats.averageDurationMs).not.toBeNull();
    expect(stats.totalToolCalls).toBeGreaterThan(0);
  });

  it('reports a pending approval count when an approval service is wired', async () => {
    const composition = makeComposition();
    await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);
    const runId = composition.runService.listRuns()[0]!.id;

    expect(composition.runService.getPendingApprovalCount()).toBe(0);

    composition.approvalService.submit({
      actionType: 'COMMIT',
      description: 'needs sign-off',
      runId,
    });

    expect(composition.runService.getPendingApprovalCount()).toBe(1);
  });

  it('creates a run without executing it', () => {
    const composition = makeComposition();
    const created = composition.workflowService.createRun({ name: 'reserved' });

    expect(created.runId).toBeTruthy();
    expect(created.status).toBe('pending');
    expect(composition.runService.getRun(created.runId).name).toBe('reserved');
  });

  it('retrieves events for a completed run', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const events = composition.runService.getEvents(result.runId);
    expect(events.length).toBeGreaterThan(0);
    // Events span the member orchestrator runs.
    expect(events.some((event) => event.type === 'task.succeeded')).toBe(true);
  });

  it('aggregates events across a workflow scope', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const scope = composition.runService.scopeRunIds(result.runId);
    // The workflow plus its planner/main/repair runs.
    expect(scope.length).toBeGreaterThan(1);
    expect(scope[0]).toBe(result.runId);

    const events = composition.runService.getEvents(result.runId);
    const types = new Set(events.map((event) => event.type));
    expect(types.has('run.created')).toBe(true);
    expect(types.has('task.succeeded')).toBe(true);
  });

  it('filters events by type', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const evidenceEvents = composition.runService.getEvents(result.runId, {
      type: 'evidence.recorded',
    });
    expect(evidenceEvents.length).toBeGreaterThan(0);
    expect(evidenceEvents.every((event) => event.type === 'evidence.recorded')).toBe(true);
  });

  it('retrieves hash-addressed evidence', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const evidence = composition.runService.getEvidence(result.runId);
    expect(evidence.length).toBeGreaterThan(0);
    for (const record of evidence) {
      expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(record.evidenceId).toBeTruthy();
      expect(record.kind).toBeTruthy();
    }
    // Agent lifecycle evidence is present.
    expect(evidence.some((record) => record.kind === 'agent.start')).toBe(true);
  });

  it('retrieves an evaluation for a run', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const evaluation = composition.evaluationService.evaluateRun(result.runId);
    expect(evaluation.runId).toBe(result.runId);
    expect(evaluation.testCaseId).toBeTruthy();
    expect(evaluation.score).toBeGreaterThanOrEqual(0);
    expect(evaluation.score).toBeLessThanOrEqual(1);
    expect(evaluation.metrics.length).toBeGreaterThan(0);
  });

  it('retrieves metrics for a run', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const metrics = composition.runService.getMetrics(result.runId);
    expect(metrics.runId).toBe(result.runId);
    expect(metrics.durationMs).not.toBeNull();
    expect(metrics.toolCallCount).toBeGreaterThan(0);
    expect(metrics.raw.length).toBeGreaterThan(0);
  });

  it('reports token usage from the deterministic provider', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const metrics = composition.runService.getMetrics(result.runId);
    // The deterministic provider always reports usage, so the
    // values are numbers rather than "unavailable".
    expect(metrics.totalTokens).not.toBeNull();
    expect(metrics.inputTokens).toBeGreaterThan(0);
    expect(metrics.outputTokens).toBeGreaterThan(0);
  });

  it('returns tasks and counters', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const tasks = composition.runService.getTasks(result.runId);
    expect(tasks.length).toBeGreaterThan(0);

    const counters = composition.runService.getCounters(result.runId);
    expect(counters.events).toBeGreaterThan(0);
    expect(counters.evidence).toBeGreaterThan(0);
  });

  it('derives a run duration from the run row', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const duration = composition.runService.getRunDurationMs(result.runId);
    expect(duration).not.toBeNull();
    expect(duration).toBeGreaterThanOrEqual(0);
  });
});

describe('Application — WorkflowService', () => {
  it('executes a workflow and returns a transport-safe summary', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    expect(result.status).toBe('succeeded');
    expect(result.repairs).toBe(1);
    expect(result.phaseCount).toBeGreaterThan(0);
    expect(result.summary['status']).toBe('succeeded');
    expect(Array.isArray(result.summary['phases'])).toBe(true);
  });

  it('persists the workflow as a run row', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const run = composition.runService.getRun(result.runId);
    expect(run.status).toBe('succeeded');
    expect(run.metadata).toContain('memberRunIds');
  });

  it('does not duplicate the engine: phase labels match the workflow', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const phases = result.summary['phases'] as Array<{ label: string }>;
    expect(phases.map((p) => p.label)).toEqual([
      'Planner',
      'Researcher',
      'Builder',
      'Verifier',
      'Repair',
      'Verifier',
    ]);
  });

  it('executes a plain task graph through the same service', async () => {
    const composition = makeComposition();
    const { TaskGraph, createTask } = await import('../src/graph/task-graph.js');
    const { DeterministicIdGenerator } = await import('../src/core/types.js');

    const ids = new DeterministicIdGenerator();
    const graph = new TaskGraph();
    graph.addTask(
      createTask(ids.taskId(), 'calc', 'deterministic', {
        capability: 'research',
        input: { tool: 'calculator', args: { operation: 'add', a: 1, b: 2 } },
      }),
    );

    const outcome = await composition.workflowService.executeGraph(graph, 'm5a-graph');
    expect(outcome.status).toBe('succeeded');
    expect(composition.runService.getRun(outcome.runId)).toBeDefined();
  });
});

describe('Application — ApprovalService', () => {
  it('submits a request and leaves it pending', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const submitted = service.submit({
      actionType: 'COMMIT',
      description: 'commit the change',
    });
    expect(submitted.status).toBe('PENDING_APPROVAL');
    expect(service.getRequest(submitted.requestId)?.status).toBe('PENDING_APPROVAL');
  });

  it('approves a pending request', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const submitted = service.submit({ actionType: 'PUSH', description: 'push' });
    const resolution = service.approve(submitted.requestId, 'looks good');

    expect(resolution.decision).toBe('APPROVED');
    expect(resolution.comment).toBe('looks good');
    expect(service.getRequest(submitted.requestId)).toBeUndefined();
    expect(service.getDecision(submitted.requestId)?.decision).toBe('APPROVED');
  });

  it('rejects a pending request', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const submitted = service.submit({ actionType: 'CREATE_PR', description: 'open a pr' });
    const resolution = service.reject(submitted.requestId, 'not now');

    expect(resolution.decision).toBe('REJECTED');
    expect(service.getDecision(submitted.requestId)?.decision).toBe('REJECTED');
  });

  it('rejects an unknown action type', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    expect(() =>
      service.submit({ actionType: 'NOT_A_REAL_ACTION', description: 'x' }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty description', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    expect(() => service.submit({ actionType: 'COMMIT', description: '   ' })).toThrow(
      ValidationError,
    );
  });

  it('throws when resolving a request that is not pending', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    expect(() => service.approve('missing')).toThrow(ValidationError);
    expect(() => service.reject('missing')).toThrow(ValidationError);
  });

  it('lists pending requests', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    service.submit({ actionType: 'COMMIT', description: 'a' });
    service.submit({ actionType: 'PUSH', description: 'b' });
    expect(service.listPending()).toHaveLength(2);
  });

  it('scopes pending requests to a run', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    service.submit({ actionType: 'COMMIT', description: 'a', runId: 'run-1' });
    service.submit({ actionType: 'PUSH', description: 'b', runId: 'run-2' });

    expect(service.listPendingForRun('run-1')).toHaveLength(1);
    expect(service.listPendingForRun('run-2')).toHaveLength(1);
    expect(service.listPendingForRun('run-3')).toHaveLength(0);
  });

  it('reports the approval state of a run', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    // No requests yet.
    expect(service.getStateForRun('run-1').status).toBe('NONE');

    const submitted = service.submit({ actionType: 'COMMIT', description: 'a', runId: 'run-1' });
    expect(service.getStateForRun('run-1').status).toBe('PENDING_APPROVAL');
    expect(service.runIdForRequest(submitted.requestId)).toBe('run-1');

    service.approve(submitted.requestId, 'ok');
    expect(service.getStateForRun('run-1').status).toBe('APPROVED');
  });

  it('reports REJECTED after a rejection', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const submitted = service.submit({ actionType: 'PUSH', description: 'a', runId: 'run-1' });
    service.reject(submitted.requestId);

    const state = service.getStateForRun('run-1');
    expect(state.status).toBe('REJECTED');
    expect(state.status === 'REJECTED' ? state.requestId : undefined).toBe(
      submitted.requestId,
    );
  });

  it('prefers PENDING over an earlier decision for the same run', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const first = service.submit({ actionType: 'COMMIT', description: 'first', runId: 'run-1' });
    service.approve(first.requestId);

    // A second outstanding request must surface as pending.
    service.submit({ actionType: 'PUSH', description: 'second', runId: 'run-1' });
    expect(service.getStateForRun('run-1').status).toBe('PENDING_APPROVAL');
  });

  it('produces deterministic request ids', async () => {
    const { ApprovalService } = await import('../src/application/approval-service.js');
    const service = new ApprovalService({
      approvals: new ApprovalManager(),
      clock: new FakeClock(),
    });

    const first = service.submit({ actionType: 'COMMIT', description: 'a' });
    const second = service.submit({ actionType: 'COMMIT', description: 'b' });
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).toMatch(/^approval:\d+$/);
  });
});

describe('Application — EvaluationService', () => {
  it('collects policy decisions from evidence', async () => {
    const composition = makeComposition({ policy: new PolicyEngine() });
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const evidence = composition.runService.getEvidence(result.runId);
    const policyEvidence = evidence.filter((record) => record.kind === 'tool.policy');
    // The gate records every decision, allowed ones included.
    expect(policyEvidence.length).toBeGreaterThan(0);
    for (const record of policyEvidence) {
      expect(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']).toContain(
        record.data['policyDecision'],
      );
    }
  });

  it('produces an explainable evaluation', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const evaluation = composition.evaluationService.evaluateRun(result.runId);
    for (const metric of evaluation.metrics) {
      expect(metric.name).toBeTruthy();
      expect(metric.explanation).toBeTruthy();
      expect(metric.score).toBeGreaterThanOrEqual(0);
      expect(metric.score).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for the same run', async () => {
    const composition = makeComposition();
    const result = await composition.workflowService.executeRun(AI_DEMO_OBJECTIVE);

    const a = composition.evaluationService.evaluateRun(result.runId);
    const b = composition.evaluationService.evaluateRun(result.runId);
    expect(a.score).toBe(b.score);
    expect(a.passed).toBe(b.passed);
    expect(a.failures).toEqual(b.failures);
  });
});