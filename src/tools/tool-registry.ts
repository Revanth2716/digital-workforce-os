import type { JsonValue } from '../core/json.js';
import type { Schema, SchemaValidation, Tool, ToolContext } from './tool.js';
import { validateSchema } from './tool.js';
import {
  DuplicateToolError,
  PolicyDeniedError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolValidationError,
} from '../core/errors.js';
import type { GateDecision, PolicyGate } from './policy-gate.js';

/** The decision and safety metadata for one executed tool call. */
export interface ToolExecutionAudit {
  readonly tool: string;
  readonly policyDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  readonly refusalReason?: string;
  readonly safetyLevel?: 'SAFE' | 'SUSPICIOUS' | 'BLOCKED';
  readonly explanation: string;
}

/**
 * Registry of named tools. Enforces unique names, resolves tools by name,
 * validates inputs against each tool's declared schema, and normalizes
 * tool failures into domain errors.
 *
 * Milestone 4: an optional policy gate is enforced inside
 * `execute()`, so every tool call in the system — including
 * those issued by agents through `ToolCaller` — passes through
 * schema validation, policy evaluation, prompt-injection
 * checking and human approval. With no gate configured the
 * registry behaves exactly as in Milestones 1-3.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly gate: PolicyGate | undefined;
  /** Observers notified after every call (used to record evidence). */
  private readonly auditors = new Set<(audit: ToolExecutionAudit) => void>();

  constructor(options: { readonly gate?: PolicyGate } = {}) {
    this.gate = options.gate;
  }

  /** Observe every tool execution decision (policy, approval, safety). */
  onAudit(listener: (audit: ToolExecutionAudit) => void): () => void {
    this.auditors.add(listener);
    return () => this.auditors.delete(listener);
  }

  private audit(entry: ToolExecutionAudit): void {
    for (const listener of this.auditors) {
      listener(entry);
    }
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Validate arguments against a tool's input schema without executing it. */
  validate(name: string, args: unknown): SchemaValidation {
    const tool = this.get(name);
    return validateSchema(tool.inputSchema as Schema, args);
  }

  /**
   * Look up, validate, and execute a tool.
   *
   * Execution order (Milestone 4):
   *   1. resolve the tool
   *   2. validate arguments against the declared schema
   *   3. policy evaluation (deny / require approval)
   *   4. prompt-injection check on the arguments
   *   5. execute
   *   6. prompt-injection check on the output
   *
   * Throws domain errors on failure; a policy refusal throws
   * `PolicyDeniedError`, which the caller's `ToolCaller`
   * converts into an `ok: false` result and records as evidence.
   */
  async execute(name: string, args: unknown, context: ToolContext): Promise<JsonValue> {
    const { output } = await this.executeWithAudit(name, args, context);
    return output;
  }

  /**
   * Execute a tool and return the policy/security decisions that
   * were observed along the way.
   *
   * `execute()` delegates here and returns only the output, so the
   * Milestone 1-3 signature is unchanged. Callers that need an
   * auditable record (such as the agent `ToolCaller`) use this
   * method to observe every decision — allowed as well as denied.
   *
   * On refusal the collected decisions are attached to the thrown
   * `PolicyDeniedError` so no decision is lost.
   */
  async executeWithAudit(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<{ readonly output: JsonValue; readonly audits: readonly ToolExecutionAudit[] }> {
    const audits: ToolExecutionAudit[] = [];
    const record = (entry: ToolExecutionAudit): void => {
      audits.push(entry);
      this.audit(entry);
    };

    const tool = this.get(name);
    const validation = validateSchema(tool.inputSchema as Schema, args);
    if (!validation.ok) {
      throw new ToolValidationError(name, validation.issues);
    }

    // ---- 3 & 4: policy evaluation + injection check on input ----
    if (this.gate !== undefined) {
      const decision: GateDecision = await this.gate.check({
        toolName: name,
        args: args as JsonValue,
        readOnly: tool.readOnly === true,
        clock: context.clock,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });

      record({
        tool: name,
        policyDecision: decision.policyDecision,
        ...(decision.refusalReason !== undefined ? { refusalReason: decision.refusalReason } : {}),
        ...(decision.safetyLevel !== undefined ? { safetyLevel: decision.safetyLevel } : {}),
        explanation: decision.explanation,
      });

      if (!decision.allowed) {
        throw new PolicyDeniedError(
          name,
          decision.policyDecision,
          decision.refusalReason ?? 'unspecified',
          decision.explanation,
          audits,
        );
      }
    }

    try {
      const output = await tool.execute(args as JsonValue, context);

      // ---- 6: prompt-injection check on the output ----
      if (this.gate !== undefined) {
        const inspected = await (this.gate as PolicyGate & {
          inspectOutput?: (toolName: string, output: JsonValue) => GateDecision;
        }).inspectOutput?.(name, output);

        if (inspected !== undefined) {
          record({
            tool: name,
            policyDecision: inspected.policyDecision,
            ...(inspected.refusalReason !== undefined
              ? { refusalReason: inspected.refusalReason }
              : {}),
            ...(inspected.safetyLevel !== undefined
              ? { safetyLevel: inspected.safetyLevel }
              : {}),
            explanation: inspected.explanation,
          });

          if (!inspected.allowed) {
            throw new PolicyDeniedError(
              name,
              inspected.policyDecision,
              inspected.refusalReason ?? 'unspecified',
              inspected.explanation,
              audits,
            );
          }
        }
      }

      return { output, audits };
    } catch (error) {
      if (
        error instanceof ToolExecutionError ||
        error instanceof ToolValidationError ||
        error instanceof PolicyDeniedError
      ) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new ToolExecutionError(name, error);
    }
  }
}
