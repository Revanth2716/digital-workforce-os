import type { ToolRegistry } from './tool-registry.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import type { ApprovalManager } from '../approval/approval-manager.js';
import type { ApprovalActionType } from '../approval/approval-request.js';
import { analyzeText } from '../security/injection-detector.js';
import type { Clock } from '../core/types.js';
import type { JsonValue } from '../core/json.js';

/**
 * Policy gate for the existing ToolRegistry (Milestone 4).
 *
 * The gate is injected into `ToolRegistry` and enforced inside
 * `ToolRegistry.execute()`, making the registry the single
 * chokepoint every agent tool call already flows through:
 *
 *   Agent -> ToolCallRequest -> ToolRegistry.execute()
 *        -> schema validation (registry)
 *        -> policy gate (ALLOW | DENY | REQUIRE_APPROVAL)
 *        -> injection/trust check on args and output
 *        -> approval when required
 *        -> tool execution
 *        -> ToolCallResult -> evidence
 *
 * There is no second execution path: agents cannot invoke a tool
 * without passing this gate. When no gate is configured the
 * registry behaves exactly as in Milestones 1-3, so existing
 * behaviour is unchanged.
 */

/** Why a tool call was refused by the gate. */
export type GateRefusalReason =
  | 'unknown_tool'
  | 'policy_denied'
  | 'approval_denied'
  | 'approval_unavailable'
  | 'injection_input'
  | 'injection_output';

/** The gate's decision for one tool call. */
export interface GateDecision {
  /** Whether the call may proceed. */
  readonly allowed: boolean;
  /** The policy decision that produced this outcome. */
  readonly policyDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  /** Set when the call is refused. */
  readonly refusalReason?: GateRefusalReason;
  /** Human-readable explanation, recorded as evidence. */
  readonly explanation: string;
  /** Safety level of the inspected payload, when checked. */
  readonly safetyLevel?: 'SAFE' | 'SUSPICIOUS' | 'BLOCKED';
}

/** Configuration for the policy gate. */
export interface PolicyGateConfig {
  readonly policyEngine: PolicyEngine;
  readonly approvalManager?: ApprovalManager;
  /**
   * Inspect tool arguments and output for prompt-injection
   * patterns. Defaults to true.
   */
  readonly checkInjection?: boolean;
}

/**
 * Capable of deciding whether a single tool call may proceed.
 * Owned by the consumer (ToolRegistry) and injected at
 * construction, so the registry depends on the interface only.
 */
export interface PolicyGate {
  /** Decide whether a call may proceed. */
  check(request: GateRequest): Promise<GateDecision>;
}

/** One tool call presented to the gate. */
export interface GateRequest {
  readonly toolName: string;
  readonly args: JsonValue;
  readonly readOnly: boolean;
  readonly clock: Clock;
  /** Optional abort signal from the executing task. */
  readonly signal?: AbortSignal;
}

/**
 * Default gate: capability-based policy evaluation, human
 * approval for sensitive capabilities, and a deterministic
 * prompt-injection check on arguments and output.
 */
export class DefaultPolicyGate implements PolicyGate {
  private readonly policyEngine: PolicyEngine;
  private readonly approvalManager: ApprovalManager | undefined;
  private readonly checkInjection: boolean;
  private counter = 0;

  constructor(config: PolicyGateConfig) {
    this.policyEngine = config.policyEngine;
    this.approvalManager = config.approvalManager;
    this.checkInjection = config.checkInjection ?? true;
  }

  async check(request: GateRequest): Promise<GateDecision> {
    // ---- Default-deny for tools with no declared capability ----
    // An unmapped tool has not been authorized by the policy
    // owner, so it is refused before any capability is
    // considered. This closes the gap where a newly added
    // tool would otherwise be implicitly allowed.
    const capability = this.policyEngine.capabilityFor(request.toolName);
    if (capability === undefined) {
      return {
        allowed: false,
        policyDecision: 'DENY',
        refusalReason: 'unknown_tool',
        explanation:
          `policy denied '${request.toolName}': tool has no declared capability ` +
          '(unmapped tools are denied by default; register it in PolicyEngine.TOOL_CAPABILITIES to authorize it)',
      };
    }

    const decision = this.policyEngine.evaluate(capability);

    if (decision.decision === 'DENY') {
      return {
        allowed: false,
        policyDecision: 'DENY',
        refusalReason: 'policy_denied',
        explanation: `policy denied '${request.toolName}': ${decision.explanation}`,
      };
    }

    if (decision.decision === 'REQUIRE_APPROVAL') {
      const approval = await this.resolveApproval(request.toolName, capability);
      if (approval !== 'APPROVED') {
        return {
          allowed: false,
          policyDecision: 'REQUIRE_APPROVAL',
          refusalReason:
            approval === 'REJECTED' ? 'approval_denied' : 'approval_unavailable',
          explanation:
            approval === 'REJECTED'
              ? `approval rejected for capability '${capability}' (tool '${request.toolName}')`
              : `approval required for '${capability}' but no approval handler is configured`,
        };
      }
    }

    // ---- Prompt-injection check on the arguments ----
    if (this.checkInjection) {
      const inputResult = analyzeText(safeStringify(request.args), `tool:${request.toolName}:input`);
      if (inputResult.level === 'BLOCKED') {
        return {
          allowed: false,
          policyDecision: 'DENY',
          refusalReason: 'injection_input',
          safetyLevel: 'BLOCKED',
          explanation: `prompt-injection blocked in tool input: ${inputResult.reason}`,
        };
      }
    }

    return {
      allowed: true,
      policyDecision: this.policyEngine.getDecision(capability),
      explanation: `policy allowed '${request.toolName}' (capability '${capability}')`,
    };
  }

  /**
   * Inspect tool output after execution. Returns a refusal when
   * the output itself carries a blocked injection payload;
   * suspicious output is allowed through but reported so the
   * caller can record it as evidence.
   */
  inspectOutput(toolName: string, output: JsonValue): GateDecision {
    if (!this.checkInjection) {
      return { allowed: true, policyDecision: 'ALLOW', explanation: `output inspection disabled for '${toolName}'` };
    }

    const result = analyzeText(safeStringify(output), `tool:${toolName}:output`);
    if (result.level === 'BLOCKED') {
      return {
        allowed: false,
        policyDecision: 'DENY',
        refusalReason: 'injection_output',
        safetyLevel: 'BLOCKED',
        explanation: `prompt-injection blocked in tool output: ${result.reason}`,
      };
    }
    return {
      allowed: true,
      policyDecision: 'ALLOW',
      safetyLevel: result.level,
      explanation:
        result.level === 'SUSPICIOUS'
          ? `suspicious content in tool output: ${result.reason}`
          : 'tool output is safe',
    };
  }

  /** Run the approval flow for a sensitive capability. */
  private async resolveApproval(
    toolName: string,
    capability: string,
  ): Promise<'APPROVED' | 'REJECTED' | 'UNAVAILABLE'> {
    if (this.approvalManager === undefined) return 'UNAVAILABLE';

    // Deterministic, monotonic request ids keep replays stable.
    this.counter += 1;
    const request = this.approvalManager.createRequest(
      `approval-${capability}-${this.counter}`,
      capability as ApprovalActionType,
      `tool '${toolName}' requires approval for capability '${capability}'`,
      Date.now(),
    );

    const decision = await this.approvalManager.requestApproval(request);
    if (decision === undefined) return 'UNAVAILABLE';
    return decision.decision;
  }
}

/**
 * A gate that always allows. Used when no policy is configured so
 * Milestone 1-3 behaviour is preserved exactly.
 */
export const PERMISSIVE_GATE: PolicyGate = {
  async check(): Promise<GateDecision> {
    return { allowed: true, policyDecision: 'ALLOW', explanation: 'no policy configured' };
  },
};

/** JSON.stringify that never throws on cycles or bigints. */
function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Convenience: build a gate from a policy engine. */
export function createPolicyGate(
  policyEngine: PolicyEngine,
  approvalManager?: ApprovalManager,
): DefaultPolicyGate {
  return new DefaultPolicyGate({
    policyEngine,
    ...(approvalManager !== undefined ? { approvalManager } : {}),
  });
}

/** Re-exported so callers can assert registry wiring. */
export type { ToolRegistry };