/** Machine-readable error codes for every domain failure. */
export type ErrorCode =
  | 'validation'
  | 'cycle_detected'
  | 'task_not_found'
  | 'duplicate_task'
  | 'agent_not_found'
  | 'duplicate_agent'
  | 'capability_mismatch'
  | 'tool_not_found'
  | 'duplicate_tool'
  | 'tool_validation'
  | 'tool_execution'
  | 'run_not_found'
  | 'cancellation'
  | 'timeout'
  | 'orchestration'
  | 'persistence'
  | 'provider'
  | 'structured_output';

/**
 * Base class for all domain errors. Carries a stable `code` so callers can
 * branch on error kinds without instanceof checks, plus optional `details`
 * for structured context and an optional `cause` for error chaining.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, options?: { readonly details?: Record<string, unknown> }) {
    super('validation', message, options);
  }
}

export class CycleError extends DomainError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super('cycle_detected', `Cycle detected in task graph: ${cycle.join(' -> ')}`, {
      details: { cycle: [...cycle] },
    });
    this.cycle = cycle;
  }
}

export class TaskNotFoundError extends DomainError {
  constructor(taskId: string) {
    super('task_not_found', `Task not found: ${taskId}`, { details: { taskId } });
  }
}

export class DuplicateTaskError extends DomainError {
  constructor(taskId: string) {
    super('duplicate_task', `Duplicate task id: ${taskId}`, { details: { taskId } });
  }
}

export class AgentNotFoundError extends DomainError {
  constructor(agentName: string) {
    super('agent_not_found', `Agent not registered: ${agentName}`, { details: { agentName } });
  }
}

export class DuplicateAgentError extends DomainError {
  constructor(agentName: string) {
    super('duplicate_agent', `Agent already registered: ${agentName}`, { details: { agentName } });
  }
}

export class CapabilityMismatchError extends DomainError {
  constructor(agentName: string, capability: string) {
    super('capability_mismatch', `Agent '${agentName}' does not support capability '${capability}'`, {
      details: { agentName, capability },
    });
  }
}

export class ToolNotFoundError extends DomainError {
  constructor(toolName: string) {
    super('tool_not_found', `Tool not registered: ${toolName}`, { details: { toolName } });
  }
}

export class DuplicateToolError extends DomainError {
  constructor(toolName: string) {
    super('duplicate_tool', `Tool already registered: ${toolName}`, { details: { toolName } });
  }
}

export class ToolValidationError extends DomainError {
  readonly issues: readonly string[];

  constructor(toolName: string, issues: readonly string[]) {
    super('tool_validation', `Invalid input for tool '${toolName}': ${issues.join('; ')}`, {
      details: { toolName, issues: [...issues] },
    });
    this.issues = issues;
  }
}

export class ToolExecutionError extends DomainError {
  constructor(toolName: string, cause?: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super('tool_execution', `Tool '${toolName}' failed: ${message}`, { cause });
  }
}

export class RunNotFoundError extends DomainError {
  constructor(runId: string) {
    super('run_not_found', `Run not found: ${runId}`, { details: { runId } });
  }
}

export class CancellationError extends DomainError {
  constructor(message: string = 'Operation cancelled') {
    super('cancellation', message);
  }
}

export class TimeoutError extends DomainError {
  constructor(timeoutMs: number) {
    super('timeout', `Operation timed out after ${timeoutMs}ms`, { details: { timeoutMs } });
  }
}

export class OrchestrationError extends DomainError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('orchestration', message, options);
  }
}

export class PersistenceError extends DomainError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('persistence', message, options);
  }
}

export class ProviderError extends DomainError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('provider', message, options);
  }
}

/**
 * A model returned output that could not be validated against the
 * requested structured schema. Carries the validation issues so
 * callers (and the evidence log) can report exactly what failed.
 */
export class StructuredOutputError extends DomainError {
  readonly issues: readonly string[];

  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly issues?: readonly string[];
    },
  ) {
    super('structured_output', message, options);
    this.issues = options?.issues ?? [];
  }
}
