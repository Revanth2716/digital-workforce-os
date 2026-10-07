/**
 * Milestone 4 hardening: default-deny for unknown tools, and
 * evidence-based policy compliance metrics.
 */

import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { DefaultPolicyGate } from '../src/tools/policy-gate.js';
import { CalculatorTool, WordCountTool } from '../src/tools/builtin-tools.js';
import { ApprovalManager } from '../src/approval/approval-manager.js';
import { PolicyDeniedError, ToolNotFoundError } from '../src/core/errors.js';
import { FakeClock } from '../src/core/types.js';
import type { JsonValue } from '../src/core/json.js';
import type { Tool } from '../src/tools/tool.js';
import { evaluateRun } from '../src/evaluation/evaluator.js';
import type { PolicyEvidence } from '../src/evaluation/evaluator.js';
import { getTestCase } from '../src/evaluation/dataset.js';
import { readPolicyDecisions } from '../src/orchestrator/safety-demo.js';
import { CommitTool } from './helpers/policy-tools.js';

function gateFor(engine: PolicyEngine): DefaultPolicyGate {
  return new DefaultPolicyGate({ policyEngine: engine });
}

describe('Hardening — default-deny unknown tools', () => {
  /** A tool that exists in the registry but has no declared capability. */
  function unmappedTool(name: string, onRun: () => void = () => undefined): Tool {
    return {
      name,
      description: 'A tool with no declared capability',
      inputSchema: { type: 'object', properties: {}, required: [] },
      readOnly: true,
      async execute(): Promise<JsonValue> {
        onRun();
        return { ran: true } as JsonValue;
      },
    };
  }

  it('denies a registered tool with no declared capability', async () => {
    let executed = false;
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    registry.register(unmappedTool('totally.unmapped', () => {
      executed = true;
    }));

    const error = await registry
      .execute('totally.unmapped', {}, { clock: new FakeClock() })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolicyDeniedError);
    const denial = error as PolicyDeniedError;
    expect(denial.policyDecision).toBe('DENY');
    // A distinct reason proves it was the unknown-tool path,
    // not an ordinary capability denial.
    expect(denial.refusalReason).toBe('unknown_tool');
    // The critical assertion: the body never ran.
    expect(executed).toBe(false);
  });

  it('denies an unmapped tool even when the policy engine denies other capabilities', async () => {
    // A rule that denies READ must not be the reason an unmapped
    // tool is blocked — the unmapped-tool check runs first.
    const engine = new PolicyEngine({
      rules: [{ capability: 'READ', decision: 'DENY' }],
    });
    const registry = new ToolRegistry({ gate: gateFor(engine) });
    registry.register(unmappedTool('mystery.tool'));

    const error = (await registry
      .execute('mystery.tool', {}, { clock: new FakeClock() })
      .catch((e: unknown) => e)) as PolicyDeniedError;

    expect(error.refusalReason).toBe('unknown_tool');
  });

  it('still reports ToolNotFoundError for a tool that does not exist', async () => {
    // A tool absent from the registry is a lookup failure, not a
    // policy decision — the two must not be conflated.
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    await expect(
      registry.execute('never.registered', {}, { clock: new FakeClock() }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it('reports unknown_tool as structured policy evidence', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    registry.register(unmappedTool('mystery.tool'));
    registry.onAudit((audit) => {
      audits.push(audit as unknown as Record<string, unknown>);
    });

    await registry
      .execute('mystery.tool', {}, { clock: new FakeClock() })
      .catch(() => undefined);

    expect(audits).toHaveLength(1);
    expect(audits[0]?.['policyDecision']).toBe('DENY');
    expect(audits[0]?.['refusalReason']).toBe('unknown_tool');
    expect(String(audits[0]?.['explanation'])).toContain('no declared capability');
  });

  it('carries the decision on the error for evidence recording', async () => {
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    registry.register(unmappedTool('mystery.tool'));

    const error = (await registry
      .execute('mystery.tool', {}, { clock: new FakeClock() })
      .catch((e: unknown) => e)) as PolicyDeniedError;

    // The audit trail survives the refusal so nothing is lost.
    expect(error.audits).toHaveLength(1);
    expect(error.audits[0]?.refusalReason).toBe('unknown_tool');
  });

  it('keeps every shipped tool working', async () => {
    const engine = new PolicyEngine();
    const registry = new ToolRegistry({ gate: gateFor(engine) });
    registry.register(new CalculatorTool());
    registry.register(new WordCountTool());

    const clock = new FakeClock();

    // Both builtins have declared capabilities and still run.
    await expect(
      registry.execute('calculator', { operation: 'add', a: 2, b: 3 }, { clock }),
    ).resolves.toBe(5);
    await expect(
      registry.execute('word_count', { text: 'a b c' }, { clock }),
    ).resolves.toEqual({ words: 3, characters: 5, lines: 1 });
  });

  it('keeps every shipped MCP tool mapped to a capability', () => {
    for (const tool of [
      'repository.inspect',
      'repository.search',
      'file.read',
      'knowledge.search',
      'workflow.status',
    ]) {
      expect(PolicyEngine.isKnownTool(tool)).toBe(true);
      expect(PolicyEngine.capabilityForTool(tool)).toBeDefined();
    }
  });

  it('authorizes an unmapped tool only when explicitly registered', async () => {
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    registry.register(new WordCountTool());

    // Denied before authorization...
    await expect(
      registry.execute('word_count', { text: 'hi' }, { clock: new FakeClock() }),
    ).resolves.toBeDefined();

    const engine = new PolicyEngine().authorizeTool('my.custom.tool', 'READ');
    expect(engine.capabilityFor('my.custom.tool')).toBe('READ');
    expect(engine.authorizedToolNames).toContain('my.custom.tool');

    // ...and revoking restores the default deny.
    engine.unauthorizeTool('my.custom.tool');
    expect(engine.capabilityFor('my.custom.tool')).toBeUndefined();
  });

  it('leaves an unguarded registry permissive (M1-M3 behaviour)', async () => {
    // With no gate at all there is no policy boundary, so an
    // unmapped tool still runs. The default-deny guarantee is a
    // property of the armed gate, not of the registry alone.
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      unmappedTool('legacy.tool', () => {
        executed = true;
      }),
    );

    await registry.execute('legacy.tool', {}, { clock: new FakeClock() });
    expect(executed).toBe(true);
  });
});

// ---- Policy compliance metrics ---------------------------------------------

function baseContext(decisions: readonly PolicyEvidence[]) {
  return {
    runId: 'r1',
    objective: 'test',
    output: { status: 'ok' },
    succeeded: true,
    repairs: 0,
    evidence: ['ev-1'],
    policyDecisions: decisions,
  };
}

const successCase = getTestCase('tc-001-successful-research')!;
const unauthorizedCase = getTestCase('tc-004-unauthorized-tool')!;

function metricNamed(result: ReturnType<typeof evaluateRun>, name: string) {
  return result.metrics.find((m) => m.name === name);
}

describe('Hardening — policy compliance from evidence', () => {
  it('is derived from policy evidence, not from run success', () => {
    // A failed run with clean policy evidence must not be scored
    // as a policy violation.
    const result = evaluateRun(
      { ...baseContext([{ tool: 'calculator', policyDecision: 'ALLOW', allowed: true }]), succeeded: false },
      { ...successCase, expected: { ...successCase.expected, shouldSucceed: false } },
    );

    const enforcement = metricNamed(result, 'policy_enforcement');
    expect(enforcement).toBeDefined();
    expect(enforcement?.passed).toBe(true);
  });

  it('scores an allowed action as compliant', () => {
    const result = evaluateRun(
      baseContext([
        { tool: 'calculator', policyDecision: 'ALLOW', allowed: true },
        { tool: 'word_count', policyDecision: 'ALLOW', allowed: true },
      ]),
      successCase,
    );

    expect(metricNamed(result, 'policy_enforcement')?.passed).toBe(true);
    expect(metricNamed(result, 'policy_decision_consistency')?.passed).toBe(true);
    expect(metricNamed(result, 'policy_violation_attempts')?.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('detects an attempted violation from a denied decision', () => {
    const result = evaluateRun(
      baseContext([
        { tool: 'calculator', policyDecision: 'ALLOW', allowed: true },
        {
          tool: 'command.execute',
          policyDecision: 'DENY',
          allowed: false,
          refusalReason: 'policy_denied',
        },
      ]),
      successCase,
    );

    const attempts = metricNamed(result, 'policy_violation_attempts');
    expect(attempts?.score).toBe(0.5);
    // Enforcement still held: the denied tool did not run.
    expect(metricNamed(result, 'policy_enforcement')?.passed).toBe(true);
    // The violation attempt is surfaced as a failure.
    expect(result.failures.join(' ')).toContain('policy violation attempt');
    expect(result.passed).toBe(false);
  });

  it('distinguishes REQUIRE_APPROVAL from ALLOW and DENY', () => {
    const result = evaluateRun(
      baseContext([
        { tool: 'calculator', policyDecision: 'ALLOW', allowed: true },
        { tool: 'git.commit', policyDecision: 'REQUIRE_APPROVAL', allowed: false, refusalReason: 'approval_unavailable' },
        { tool: 'git.push', policyDecision: 'DENY', allowed: false, refusalReason: 'policy_denied' },
      ]),
      unauthorizedCase,
    );

    const attempts = metricNamed(result, 'policy_violation_attempts');
    const byDecision = attempts?.details?.['byDecision'] as Record<string, number>;
    expect(byDecision['ALLOW']).toBe(1);
    expect(byDecision['REQUIRE_APPROVAL']).toBe(1);
    expect(byDecision['DENY']).toBe(1);

    // Both refusals counted as violation attempts.
    expect(attempts?.details?.['violations']).toBe(2);
    // Refusal reasons are recorded and explainable.
    expect(attempts?.details?.['refusalReasons']).toEqual([
      'approval_unavailable',
      'policy_denied',
    ]);
  });

  it('treats an approved REQUIRE_APPROVAL as compliant', () => {
    // Approval granted => the decision is recorded with no refusal
    // reason and the call was allowed.
    const result = evaluateRun(
      baseContext([
        { tool: 'git.commit', policyDecision: 'REQUIRE_APPROVAL', allowed: true },
      ]),
      successCase,
    );

    expect(metricNamed(result, 'policy_violation_attempts')?.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('fails enforcement when a denied tool executed anyway', () => {
    const result = evaluateRun(
      baseContext([
        { tool: 'command.execute', policyDecision: 'DENY', allowed: true },
      ]),
      unauthorizedCase,
    );

    const enforcement = metricNamed(result, 'policy_enforcement');
    expect(enforcement?.passed).toBe(false);
    expect(enforcement?.explanation).toContain('denied tool call(s) executed');
  });

  it('fails consistency when a decision contradicts its outcome', () => {
    const result = evaluateRun(
      baseContext([
        { tool: 'calculator', policyDecision: 'ALLOW', allowed: false },
      ]),
      unauthorizedCase,
    );

    expect(metricNamed(result, 'policy_decision_consistency')?.passed).toBe(false);
  });

  it('skips policy metrics entirely when no evidence is supplied', () => {
    const result = evaluateRun(
      {
        runId: 'r1',
        objective: 'test',
        output: {},
        succeeded: true,
        repairs: 0,
        evidence: ['ev-1'],
      },
      successCase,
    );

    expect(metricNamed(result, 'policy_enforcement')).toBeUndefined();
    expect(metricNamed(result, 'policy_decision_consistency')).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('is deterministic for identical evidence', () => {
    const decisions: PolicyEvidence[] = [
      { tool: 'calculator', policyDecision: 'ALLOW', allowed: true },
      { tool: 'git.push', policyDecision: 'DENY', allowed: false, refusalReason: 'policy_denied' },
    ];
    const a = evaluateRun(baseContext(decisions), unauthorizedCase);
    const b = evaluateRun(baseContext(decisions), unauthorizedCase);

    expect(a.score).toBe(b.score);
    expect(a.failures).toEqual(b.failures);
  });

  it('reads real policy decisions out of an evidence log', () => {
    // Exercises readPolicyDecisions against a stub event source.
    const decisions = readPolicyDecisions({
      events: {
        listAll: () => [
          {
            type: 'evidence.recorded',
            payload: {
              kind: 'tool.policy',
              data: { tool: 'calculator', policyDecision: 'ALLOW', allowed: true, refusalReason: null },
            },
          },
          {
            type: 'evidence.recorded',
            payload: {
              kind: 'tool.policy',
              data: {
                tool: 'git.push',
                policyDecision: 'DENY',
                allowed: false,
                refusalReason: 'policy_denied',
              },
            },
          },
          { type: 'task.started', payload: {} },
        ],
      },
    });

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual({
      tool: 'calculator',
      policyDecision: 'ALLOW',
      allowed: true,
    });
    expect(decisions[1]?.refusalReason).toBe('policy_denied');

    // And they feed straight into the metric.
    const result = evaluateRun(baseContext(decisions), unauthorizedCase);
    expect(metricNamed(result, 'policy_violation_attempts')?.details?.['violations']).toBe(1);
  });

  it('records an approval-gated call that was granted', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const engine = new PolicyEngine();
    const approval = new ApprovalManager(async (request) => ({
      requestId: request.id,
      decision: 'APPROVED' as const,
      decidedAt: Date.now(),
    }));

    const registry = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: engine, approvalManager: approval }),
    });
    registry.register(new CommitTool());
    registry.onAudit((audit) => audits.push(audit as unknown as Record<string, unknown>));

    await registry.execute('git.commit', { message: 'chore: test' }, { clock: new FakeClock() });

    expect(audits[0]?.['policyDecision']).toBe('REQUIRE_APPROVAL');
    expect(audits[0]?.['refusalReason']).toBeUndefined();
  });

  it('records an approval-gated call that was refused', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry({ gate: gateFor(new PolicyEngine()) });
    registry.register(new CommitTool());
    registry.onAudit((audit) => audits.push(audit as unknown as Record<string, unknown>));

    await registry
      .execute('git.commit', { message: 'chore: test' }, { clock: new FakeClock() })
      .catch(() => undefined);

    expect(audits[0]?.['policyDecision']).toBe('REQUIRE_APPROVAL');
    expect(audits[0]?.['refusalReason']).toBe('approval_unavailable');
  });
});