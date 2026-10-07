/**
 * Policy engine (Milestone 4).
 *
 * Evaluates tool/action requests against a capability-based
 * policy. Every tool execution must pass through the policy
 * engine — agents cannot bypass it.
 *
 * The policy engine is deterministic: the same request
 * always produces the same decision.
 */

import type { Capability, PolicyDecision } from './capabilities.js';
import { DEFAULT_POLICY, isCapability } from './capabilities.js';
import type { PolicyDecisionResult } from './decisions.js';
import { allow, deny, requireApproval } from './decisions.js';

/** A policy rule mapping a capability to a decision. */
export interface PolicyRule {
  readonly capability: Capability;
  readonly decision: PolicyDecision;
  readonly explanation?: string;
}

/** Configuration for the policy engine. */
export interface PolicyEngineConfig {
  /** Custom rules overriding the default policy. */
  readonly rules?: readonly PolicyRule[];
}

/**
 * The policy engine evaluates requests against the configured
 * policy and returns structured decisions.
 */
export class PolicyEngine {
  private readonly rules: Readonly<Record<Capability, PolicyDecision>>;
  private readonly explanations: Readonly<Partial<Record<Capability, string>>>;
  /** Tools authorized beyond the shipped defaults. */
  private readonly authorizedTools = new Map<string, Capability>();

  constructor(config: PolicyEngineConfig = {}) {
    const rules: Record<Capability, PolicyDecision> = { ...DEFAULT_POLICY };
    const explanations: Partial<Record<Capability, string>> = {};

    for (const rule of config.rules ?? []) {
      rules[rule.capability] = rule.decision;
      if (rule.explanation !== undefined) {
        explanations[rule.capability] = rule.explanation;
      }
    }

    this.rules = rules;
    this.explanations = explanations;
  }

  /**
   * Evaluate a capability request.
   * Returns a structured decision with explanation.
   */
  evaluate(capability: Capability): PolicyDecisionResult {
    const decision = this.rules[capability];
    const explanation = this.explanations[capability];

    switch (decision) {
      case 'ALLOW':
        return allow(capability, explanation);
      case 'DENY':
        return deny(capability, explanation);
      case 'REQUIRE_APPROVAL':
        return requireApproval(capability, explanation);
    }
  }

  /**
   * Check if a capability is allowed without approval.
   */
  isAllowed(capability: Capability): boolean {
    return this.rules[capability] === 'ALLOW';
  }

  /**
   * Check if a capability requires approval.
   */
  requiresApproval(capability: Capability): boolean {
    return this.rules[capability] === 'REQUIRE_APPROVAL';
  }

  /**
   * Check if a capability is denied.
   */
  isDenied(capability: Capability): boolean {
    return this.rules[capability] === 'DENY';
  }

  /**
   * Get the decision for a capability.
   */
  getDecision(capability: Capability): PolicyDecision {
    return this.rules[capability];
  }

  /**
   * The explicit tool -> capability map.
   *
   * Every tool the system ships with must appear here. A tool
   * that is absent is NOT silently ungated: `capabilityForTool`
   * returns undefined and the policy gate denies it by default
   * (see `DefaultPolicyGate`). This map is the single place a
   * new tool must be registered to become callable.
   */
  static readonly TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
    // Read-only tools (pure computation)
    calculator: 'READ',
    word_count: 'READ',
    // Search tools
    'repository.search': 'SEARCH',
    'repository.inspect': 'SEARCH',
    'knowledge.search': 'KNOWLEDGE_RETRIEVE',
    // File tools
    'file.read': 'READ',
    'file.write': 'WRITE_WORKSPACE',
    // Execution tools
    'command.execute': 'EXECUTE_SAFE_COMMAND',
    // Git tools
    'git.commit': 'COMMIT',
    'git.push': 'PUSH',
    'pr.create': 'CREATE_PR',
    // Workflow status is a read-only observation
    'workflow.status': 'READ',
  };

  /**
   * Resolve the capability required by a tool name.
   *
   * Returns undefined for any tool that is not explicitly
   * mapped. Callers MUST treat undefined as DENY: an unmapped
   * tool has no declared capability, so it is not authorized.
   */
  static capabilityForTool(toolName: string): Capability | undefined {
    return PolicyEngine.TOOL_CAPABILITIES[toolName];
  }

  /**
   * Whether a tool has an explicitly declared capability in the
   * shipped default map.
   */
  static isKnownTool(toolName: string): boolean {
    return PolicyEngine.TOOL_CAPABILITIES[toolName] !== undefined;
  }

  /**
   * Explicitly authorize an additional tool by mapping it to a
   * capability.
   *
   * The shipped tools in `TOOL_CAPABILITIES` are authorized by
   * default. Any other tool is denied until it is registered here,
   * so adding a tool to the system never implicitly grants it
   * access. Returns the engine for chaining.
   */
  authorizeTool(toolName: string, capability: Capability): this {
    this.authorizedTools.set(toolName, capability);
    return this;
  }

  /**
   * Remove an authorization granted via `authorizeTool`.
   * The tool becomes denied again. Shipped defaults cannot be
   * removed this way; use a `DENY` rule to override them.
   */
  unauthorizeTool(toolName: string): this {
    this.authorizedTools.delete(toolName);
    return this;
  }

  /**
   * Resolve the capability for a tool, honouring both the shipped
   * defaults and any explicit authorizations. Returns undefined
   * for a tool that is neither — which callers must treat as DENY.
   */
  capabilityFor(toolName: string): Capability | undefined {
    return this.authorizedTools.get(toolName) ?? PolicyEngine.TOOL_CAPABILITIES[toolName];
  }

  /** Every tool this engine authorizes. */
  get authorizedToolNames(): string[] {
    return [
      ...new Set([
        ...Object.keys(PolicyEngine.TOOL_CAPABILITIES),
        ...this.authorizedTools.keys(),
      ]),
    ].sort();
  }
}
