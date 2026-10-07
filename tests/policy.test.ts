import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { CAPABILITIES, DEFAULT_POLICY, isCapability } from '../src/policy/capabilities.js';
import { allow, deny, requireApproval } from '../src/policy/decisions.js';

describe('Policy — capabilities', () => {
  it('defines all required capabilities', () => {
    expect(CAPABILITIES).toContain('READ');
    expect(CAPABILITIES).toContain('SEARCH');
    expect(CAPABILITIES).toContain('KNOWLEDGE_RETRIEVE');
    expect(CAPABILITIES).toContain('WRITE_WORKSPACE');
    expect(CAPABILITIES).toContain('EXECUTE_SAFE_COMMAND');
    expect(CAPABILITIES).toContain('COMMIT');
    expect(CAPABILITIES).toContain('PUSH');
    expect(CAPABILITIES).toContain('CREATE_PR');
  });

  it('has a default policy for every capability', () => {
    for (const cap of CAPABILITIES) {
      expect(DEFAULT_POLICY[cap]).toBeDefined();
    }
  });

  it('validates capability names', () => {
    expect(isCapability('READ')).toBe(true);
    expect(isCapability('INVALID')).toBe(false);
  });
});

describe('Policy — decisions', () => {
  it('creates ALLOW decisions', () => {
    const decision = allow('READ');
    expect(decision.decision).toBe('ALLOW');
    expect(decision.capability).toBe('READ');
  });

  it('creates DENY decisions', () => {
    const decision = deny('PUSH');
    expect(decision.decision).toBe('DENY');
    expect(decision.capability).toBe('PUSH');
  });

  it('creates REQUIRE_APPROVAL decisions', () => {
    const decision = requireApproval('COMMIT');
    expect(decision.decision).toBe('REQUIRE_APPROVAL');
    expect(decision.capability).toBe('COMMIT');
  });
});

describe('Policy — engine', () => {
  it('allows READ by default', () => {
    const engine = new PolicyEngine();
    const decision = engine.evaluate('READ');
    expect(decision.decision).toBe('ALLOW');
  });

  it('allows SEARCH by default', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('SEARCH').decision).toBe('ALLOW');
  });

  it('requires approval for COMMIT by default', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('COMMIT').decision).toBe('REQUIRE_APPROVAL');
  });

  it('requires approval for PUSH by default', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('PUSH').decision).toBe('REQUIRE_APPROVAL');
  });

  it('requires approval for CREATE_PR by default', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('CREATE_PR').decision).toBe('REQUIRE_APPROVAL');
  });

  it('requires approval for EXECUTE_SAFE_COMMAND by default', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('EXECUTE_SAFE_COMMAND').decision).toBe('REQUIRE_APPROVAL');
  });

  it('supports custom rules', () => {
    const engine = new PolicyEngine({
      rules: [
        { capability: 'READ', decision: 'DENY', explanation: 'custom deny' },
      ],
    });
    const decision = engine.evaluate('READ');
    expect(decision.decision).toBe('DENY');
    expect(decision.explanation).toBe('custom deny');
  });

  it('maps tool names to capabilities', () => {
    expect(PolicyEngine.capabilityForTool('calculator')).toBe('READ');
    expect(PolicyEngine.capabilityForTool('word_count')).toBe('READ');
    expect(PolicyEngine.capabilityForTool('repository.search')).toBe('SEARCH');
    expect(PolicyEngine.capabilityForTool('knowledge.search')).toBe('KNOWLEDGE_RETRIEVE');
    expect(PolicyEngine.capabilityForTool('file.read')).toBe('READ');
    expect(PolicyEngine.capabilityForTool('git.commit')).toBe('COMMIT');
    expect(PolicyEngine.capabilityForTool('git.push')).toBe('PUSH');
    expect(PolicyEngine.capabilityForTool('pr.create')).toBe('CREATE_PR');
  });

  it('returns undefined for unknown tools', () => {
    expect(PolicyEngine.capabilityForTool('unknown_tool')).toBeUndefined();
  });
});

describe('Policy — tool integration (enforced inside ToolRegistry)', () => {
  it('allows a tool through the registry when policy allows it', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { DefaultPolicyGate } = await import('../src/tools/policy-gate.js');
    const { CalculatorTool } = await import('../src/tools/builtin-tools.js');
    const { FakeClock } = await import('../src/core/types.js');

    const registry = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    registry.register(new CalculatorTool());

    const clock = new FakeClock();
    const output = await registry.execute('calculator', { operation: 'add', a: 2, b: 3 }, { clock });
    expect(output).toBe(5);
  });

  it('denies a tool through the registry when policy denies it', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { DefaultPolicyGate } = await import('../src/tools/policy-gate.js');
    const { CalculatorTool } = await import('../src/tools/builtin-tools.js');
    const { FakeClock } = await import('../src/core/types.js');
    const { PolicyDeniedError } = await import('../src/core/errors.js');

    const engine = new PolicyEngine({
      rules: [{ capability: 'READ', decision: 'DENY' }],
    });
    const registry = new ToolRegistry({ gate: new DefaultPolicyGate({ policyEngine: engine }) });
    registry.register(new CalculatorTool());

    const clock = new FakeClock();
    await expect(
      registry.execute('calculator', { operation: 'add', a: 2, b: 3 }, { clock }),
    ).rejects.toThrow(PolicyDeniedError);
  });

  it('blocks execution when approval is required but no handler exists', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { DefaultPolicyGate } = await import('../src/tools/policy-gate.js');
    const { FakeClock } = await import('../src/core/types.js');
    const { PolicyDeniedError } = await import('../src/core/errors.js');
    const { CommitTool } = await import('./helpers/policy-tools.js');

    const registry = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    registry.register(new CommitTool());

    const clock = new FakeClock();
    const error = await registry
      .execute('git.commit', { message: 'chore: test' }, { clock })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as { policyDecision: string }).policyDecision).toBe('REQUIRE_APPROVAL');
    expect((error as { refusalReason: string }).refusalReason).toBe('approval_unavailable');
  });

  it('executes a sensitive tool once approval is granted', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { DefaultPolicyGate } = await import('../src/tools/policy-gate.js');
    const { ApprovalManager } = await import('../src/approval/approval-manager.js');
    const { FakeClock } = await import('../src/core/types.js');
    const { CommitTool } = await import('./helpers/policy-tools.js');

    const approval = new ApprovalManager(async (request) => ({
      requestId: request.id,
      decision: 'APPROVED' as const,
      decidedAt: Date.now(),
    }));

    const registry = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine(), approvalManager: approval }),
    });
    registry.register(new CommitTool());

    const clock = new FakeClock();
    const output = await registry.execute('git.commit', { message: 'chore: test' }, { clock });
    expect(output).toEqual({ committed: true, message: 'chore: test' });
  });

  it('does not execute when approval is rejected', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { DefaultPolicyGate } = await import('../src/tools/policy-gate.js');
    const { ApprovalManager } = await import('../src/approval/approval-manager.js');
    const { FakeClock } = await import('../src/core/types.js');
    const { CommitTool } = await import('./helpers/policy-tools.js');
    const { PolicyDeniedError } = await import('../src/core/errors.js');

    const approval = new ApprovalManager(async (request) => ({
      requestId: request.id,
      decision: 'REJECTED' as const,
      decidedAt: Date.now(),
    }));

    const registry = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine(), approvalManager: approval }),
    });
    registry.register(new CommitTool());

    const clock = new FakeClock();
    await expect(
      registry.execute('git.commit', { message: 'chore: test' }, { clock }),
    ).rejects.toThrow(PolicyDeniedError);
  });

  it('leaves the registry unguarded when no gate is configured', async () => {
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');
    const { CalculatorTool } = await import('../src/tools/builtin-tools.js');
    const { FakeClock } = await import('../src/core/types.js');

    // Milestone 1-3 behaviour: no policy, no gate.
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());

    const clock = new FakeClock();
    const output = await registry.execute('calculator', { operation: 'add', a: 1, b: 1 }, { clock });
    expect(output).toBe(2);
  });
});
