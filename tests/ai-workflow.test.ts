import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposition } from '../src/index.js';
import type { Composition } from '../src/index.js';
import type { AIWorkflowOutcome } from '../src/orchestrator/ai-workflow.js';
import {
  AI_DEMO_OBJECTIVE,
  createDemoResponses,
} from '../src/orchestrator/ai-demo.js';
import { OrchestrationError } from '../src/core/errors.js';
import type { JsonValue } from '../src/core/json.js';
import type { StoredEvent } from '../src/persistence/event-repository.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ai-'));
  tempDirs.push(dir);
  return dir;
}

interface WorkflowHarness {
  readonly composition: Composition;
  readonly dir: string;
}

function makeHarness(
  responses: Record<string, JsonValue>,
  options?: {
    readonly maxRepairCycles?: number;
  },
): WorkflowHarness {
  const dir = makeTempDir();
  const composition = createComposition({
    dbPath: join(dir, 'ai.db'),
    concurrency: 1,
    llmResponses: responses,
    maxRepairCycles: options?.maxRepairCycles,
  });
  return { composition, dir };
}

function cleanup(harness: WorkflowHarness): void {
  harness.composition.close();
  rmSync(harness.dir, { recursive: true, force: true });
}

function phaseLabels(outcome: AIWorkflowOutcome): string[] {
  return outcome.phases.map((phase) => phase.label);
}

function phaseMarks(outcome: AIWorkflowOutcome): Array<string | undefined> {
  return outcome.phases.map((phase) => {
    if (phase.status === 'failed') return '✗';
    if (phase.phase === 'verifier' && phase.verificationPassed === false) {
      return '⚠';
    }
    return '✓';
  });
}

function allEvents(harness: WorkflowHarness): StoredEvent[] {
  return harness.composition.events.listAll();
}

function evidenceKinds(harness: WorkflowHarness): string[] {
  const kinds = new Set<string>();
  for (const event of allEvents(harness)) {
    if (event.type !== 'evidence.recorded') continue;
    const payload = event.payload as { kind: string };
    kinds.add(payload.kind);
  }
  return [...kinds].sort();
}

describe('AIWorkflow — complete AI workflow', () => {
  it('runs Objective -> Planner -> Researcher -> Builder -> Verifier', async () => {
    // verify:0 passes: no repair cycle needed.
    const responses = createDemoResponses();
    responses['verify:0'] = {
      passed: true,
      summary: 'all good',
      score: 100,
      issues: [],
      evidence: [],
    };
    const harness = makeHarness(responses);
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      expect(outcome.status).toBe('succeeded');
      expect(outcome.objective).toBe(AI_DEMO_OBJECTIVE);
      expect(outcome.repairs).toBe(0);
      expect(outcome.plan.tasks).toHaveLength(3);

      // Phase order: Planner, Researcher, Builder, Verifier.
      expect(phaseLabels(outcome)).toEqual([
        'Planner',
        'Researcher',
        'Builder',
        'Verifier',
      ]);
      expect(phaseMarks(outcome)).toEqual(['✓', '✓', '✓', '✓']);

      // The plan was executed: every planned task ran.
      expect(outcome.runs).toHaveLength(2); // planner + main
      expect(outcome.runs[1]?.tasks).toHaveLength(3);

      // Final verification passed.
      expect(outcome.verification?.passed).toBe(true);

      // Persistence: planner + main runs.
      const runs = harness.composition.runs.list();
      expect(runs.map((run) => run.name).sort()).toEqual([
        'ai-main',
        'ai-planner',
      ]);
    } finally {
      cleanup(harness);
    }
  });

  it('executes the full demo scenario with one repair cycle', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      expect(outcome.status).toBe('succeeded');
      expect(outcome.repairs).toBe(1);

      // The canonical display sequence.
      expect(phaseLabels(outcome)).toEqual([
        'Planner',
        'Researcher',
        'Builder',
        'Verifier',
        'Repair',
        'Verifier',
      ]);
      expect(phaseMarks(outcome)).toEqual([
        '✓',
        '✓',
        '✓',
        '⚠',
        '✓',
        '✓',
      ]);

      // Final verification passed after the repair.
      expect(outcome.verification?.passed).toBe(true);
      expect(outcome.verification?.score).toBe(98);

      // Three orchestrator runs: planner, main, repair.
      expect(outcome.runs).toHaveLength(3);
      expect(outcome.runs.map((run) => run.runName)).toEqual([
        'ai-planner',
        'ai-main',
        'ai-repair-1',
      ]);
      expect(outcome.runs.every((run) => run.status === 'succeeded')).toBe(
        true,
      );

      // The repair run executed the repaired builder and verifier.
      const repairTasks = outcome.runs[2]?.tasks ?? [];
      expect(repairTasks).toHaveLength(2);
      expect(repairTasks.map((task) => task.agent)).toEqual([
        'builder',
        'verifier',
      ]);
      expect(repairTasks.every((task) => task.taskName.endsWith('(repair)'))).toBe(
        true,
      );
    } finally {
      cleanup(harness);
    }
  });

  it('records evidence for every AI engineering concern', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);
      expect(outcome.status).toBe('succeeded');

      const kinds = evidenceKinds(harness);
      // Agent lifecycle.
      expect(kinds).toContain('agent.start');
      expect(kinds).toContain('agent.end');
      // Model calls and structured validation.
      expect(kinds).toContain('model.call');
      expect(kinds).toContain('structured.validation');
      // Tool calls and results.
      expect(kinds).toContain('tool.call');
      expect(kinds).toContain('tool.result');
      // Verification and repair.
      expect(kinds).toContain('verification');
      expect(kinds).toContain('repair.started');
      expect(kinds).toContain('repair.completed');
      // Workflow-level outcome.
      expect(kinds).toContain('workflow.started');
      expect(kinds).toContain('workflow.outcome');
      expect(kinds).toContain('plan.created');
    } finally {
      cleanup(harness);
    }
  });

  it('persists every event to the append-only SQLite store', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      const events = allEvents(harness);
      const types = new Set(events.map((event) => event.type));
      expect(types).toContain('run.created');
      expect(types).toContain('task.started');
      expect(types).toContain('task.succeeded');
      expect(types).toContain('evidence.recorded');
      expect(types).toContain('run.completed');

      // Sequence numbers are strictly increasing (append order).
      const seqs = events.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

      // Evidence records carry content-addressed hashes.
      const evidenceEvents = events.filter(
        (event) => event.type === 'evidence.recorded',
      );
      expect(evidenceEvents.length).toBeGreaterThan(10);
      for (const event of evidenceEvents) {
        const payload = event.payload as { hash: string };
        expect(payload.hash).toMatch(/^[a-f0-9]{64}$/);
      }

      // Workflow-level evidence is grouped under the workflow id.
      const workflowEvents = harness.composition.events.listByRun(
        outcome.workflowId,
      );
      const workflowKinds = workflowEvents
        .filter((event) => event.type === 'evidence.recorded')
        .map(
          (event) =>
            (event.payload as { kind: string }).kind,
        )
        .sort();
      expect(workflowKinds).toEqual([
        'plan.created',
        'repair.completed',
        'repair.started',
        'workflow.outcome',
        'workflow.started',
      ]);
    } finally {
      cleanup(harness);
    }
  });

  it('flows previous results between agents through the context', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      const modelCalls: Array<Record<string, unknown>> = [];
      for (const event of allEvents(harness)) {
        if (event.type !== 'evidence.recorded') continue;
        const payload = event.payload as { kind: string; data: Record<string, unknown> };
        if (payload.kind === 'model.call') {
          modelCalls.push(payload.data);
        }
      }

      // The planner's output is the first previous result...
      const researchCall = modelCalls.find(
        (call) => call['intent'] === 'research',
      );
      expect(researchCall?.['previousResults']).toBe(1);

      // ...the builder sees the plan and the research...
      const buildCall = modelCalls.find((call) => call['intent'] === 'build');
      expect(buildCall?.['previousResults']).toBe(2);

      // ...and the verifier sees all three.
      const verifyCall = modelCalls.find(
        (call) => call['intent'] === 'verify:0',
      );
      expect(verifyCall?.['previousResults']).toBe(3);
    } finally {
      cleanup(harness);
    }
  });

  it('includes the failure report in the repair prompt context', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      // The repaired builder ran with the verifier's failure
      // report in its task input (persisted with the task).
      const repairRun = outcomeRun(harness, 'ai-repair-1');
      expect(repairRun).toBeDefined();
      const repairTasks = harness.composition.tasks.listByRun(
        repairRun?.id ?? '',
      );
      const builderTask = repairTasks.find(
        (task) => task.agent === 'builder',
      );
      expect(builderTask).toBeDefined();
      const input = JSON.parse(builderTask?.input ?? '{}') as {
        failure?: { passed?: boolean };
        cycle?: number;
      };
      expect(input.failure?.passed).toBe(false);
      expect(input.cycle).toBe(1);
    } finally {
      cleanup(harness);
    }
  });
});

function outcomeRun(
  harness: WorkflowHarness,
  name: string,
): { id: string } | undefined {
  return harness.composition.runs.list().find((run) => run.name === name);
}

describe('AIWorkflow — failure recovery (one repair cycle)', () => {
  it('repairs once when the verifier fails, then succeeds', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      // The first verification failed...
      const firstVerifier = outcome.phases.find(
        (phase) => phase.phase === 'verifier',
      );
      expect(firstVerifier?.verificationPassed).toBe(false);

      // ...a repair cycle ran...
      expect(outcome.repairs).toBe(1);
      const repairPhase = outcome.phases.find(
        (phase) => phase.phase === 'repair',
      );
      expect(repairPhase?.status).toBe('succeeded');

      // ...and the second verification passed.
      const verifierPhases = outcome.phases.filter(
        (phase) => phase.phase === 'verifier',
      );
      expect(verifierPhases).toHaveLength(2);
      expect(verifierPhases[0]?.verificationPassed).toBe(false);
      expect(verifierPhases[1]?.verificationPassed).toBe(true);

      expect(outcome.status).toBe('succeeded');
    } finally {
      cleanup(harness);
    }
  });

  it('records the repair lifecycle in the evidence log', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      const workflowEvents = allEvents(harness).filter(
        (event) => event.type === 'evidence.recorded',
      );
      const repairStarted = workflowEvents.filter(
        (event) =>
          (event.payload as { kind: string }).kind === 'repair.started',
      );
      const repairCompleted = workflowEvents.filter(
        (event) =>
          (event.payload as { kind: string }).kind === 'repair.completed',
      );
      expect(repairStarted).toHaveLength(1);
      expect(repairCompleted).toHaveLength(1);

      const startedData = (repairStarted[0]?.payload as {
        data: { cycle: number; failedVerifications: string[] };
      }).data;
      expect(startedData.cycle).toBe(1);
      expect(startedData.failedVerifications.length).toBe(1);

      const completedData = (repairCompleted[0]?.payload as {
        data: { cycle: number; passed: boolean };
      }).data;
      expect(completedData.passed).toBe(true);
    } finally {
      cleanup(harness);
    }
  });

  it('records verification verdicts for both cycles', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      const verdicts = allEvents(harness)
        .filter((event) => event.type === 'evidence.recorded')
        .filter(
          (event) =>
            (event.payload as { kind: string }).kind === 'verification',
        )
        .map(
          (event) =>
            (event.payload as { data: { passed: boolean; cycle: number } })
              .data,
        );

      expect(verdicts).toHaveLength(2);
      expect(verdicts[0]?.passed).toBe(false);
      expect(verdicts[0]?.cycle).toBe(0);
      expect(verdicts[1]?.passed).toBe(true);
      expect(verdicts[1]?.cycle).toBe(1);
    } finally {
      cleanup(harness);
    }
  });
});

describe('AIWorkflow — one-repair limit (never an infinite loop)', () => {
  it('stops after one repair when the verifier keeps failing', async () => {
    const responses = createDemoResponses();
    // The repair does not help: verification fails again.
    responses['verify:1'] = {
      passed: false,
      summary: 'still failing after repair',
      score: 20,
      issues: [{ severity: 'error', message: 'still broken' }],
      evidence: [],
    };
    const harness = makeHarness(responses);
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      // Exactly one repair cycle ran — no infinite loop.
      expect(outcome.repairs).toBe(1);
      expect(outcome.status).toBe('failed');

      // Planner, Researcher, Builder, Verifier, Repair, Verifier —
      // and nothing after the second failed verification.
      expect(phaseLabels(outcome)).toEqual([
        'Planner',
        'Researcher',
        'Builder',
        'Verifier',
        'Repair',
        'Verifier',
      ]);

      const verifierPhases = outcome.phases.filter(
        (phase) => phase.phase === 'verifier',
      );
      expect(verifierPhases).toHaveLength(2);
      expect(verifierPhases.every((phase) => phase.verificationPassed === false)).toBe(
        true,
      );

      // Only three orchestrator runs ever happened.
      expect(outcome.runs).toHaveLength(3);
      expect(outcome.verification?.passed).toBe(false);
    } finally {
      cleanup(harness);
    }
  }, 10_000);

  it('honours a zero repair-cycle limit', async () => {
    const harness = makeHarness(createDemoResponses(), {
      maxRepairCycles: 0,
    });
    try {
      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);

      expect(outcome.repairs).toBe(0);
      expect(outcome.status).toBe('failed');
      // No repair phase at all.
      expect(phaseLabels(outcome)).toEqual([
        'Planner',
        'Researcher',
        'Builder',
        'Verifier',
      ]);
    } finally {
      cleanup(harness);
    }
  });
});

describe('AIWorkflow — planning failures', () => {
  it('fails loudly when the planner assigns an unknown agent', async () => {
    const responses = createDemoResponses();
    responses['plan'] = {
      objective: AI_DEMO_OBJECTIVE,
      summary: 'bad plan',
      tasks: [
        {
          id: 't1',
          name: 'impossible',
          description: 'd',
          assignedAgent: 'wizard',
          tools: [],
          dependsOn: [],
          expectedOutcome: 'e',
        },
      ],
    };
    const harness = makeHarness(responses);
    try {
      await expect(
        harness.composition.ai.run(AI_DEMO_OBJECTIVE),
      ).rejects.toThrow(OrchestrationError);
    } finally {
      cleanup(harness);
    }
  });

  it('fails loudly when the planner output violates the schema', async () => {
    const responses = createDemoResponses();
    responses['plan'] = { not: 'a plan' };
    const harness = makeHarness(responses);
    try {
      await expect(
        harness.composition.ai.run(AI_DEMO_OBJECTIVE),
      ).rejects.toThrow(OrchestrationError);
    } finally {
      cleanup(harness);
    }
  });

  it('fails loudly when a specialist agent throws', async () => {
    const responses = createDemoResponses();
    // The researcher's output is schema-invalid: the agent
    // throws, the run fails, the workflow reports it.
    responses['research'] = { topic: 'incomplete' };
    const harness = makeHarness(responses);
    try {
      await expect(
        harness.composition.ai.run(AI_DEMO_OBJECTIVE),
      ).rejects.toThrow(OrchestrationError);
    } finally {
      cleanup(harness);
    }
  });
});

describe('AIWorkflow — provider neutrality', () => {
  it('runs on the deterministic provider with zero network by default', async () => {
    const harness = makeHarness(createDemoResponses());
    try {
      const provider = harness.composition.llm;
      expect(provider.name).toBe('deterministic');
      expect(provider.model.capabilities).toContain('structured-output');

      const outcome = await harness.composition.ai.run(AI_DEMO_OBJECTIVE);
      expect(outcome.status).toBe('succeeded');

      // Every model call in the evidence log went to the
      // deterministic provider — no external endpoint involved.
      const providers = new Set<string>();
      for (const event of allEvents(harness)) {
        if (event.type !== 'evidence.recorded') continue;
        const payload = event.payload as {
          kind: string;
          data: { provider?: string };
        };
        if (payload.kind === 'model.call' && payload.data.provider) {
          providers.add(payload.data.provider);
        }
      }
      expect([...providers]).toEqual(['deterministic']);
    } finally {
      cleanup(harness);
    }
  });
});
