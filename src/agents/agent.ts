import type { Clock, RunId, TaskId } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { EvidenceLog } from '../events/evidence.js';

/** Everything an agent needs to execute a single task attempt. */
export interface AgentContext {
  readonly runId: RunId;
  readonly taskId: TaskId;
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Aborted when the run is cancelled or a failure triggers fail-fast. */
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly tools: ToolRegistry;
  /** Agents record evidence through this; it emits typed events. */
  readonly evidence: EvidenceLog;
}

/** What an agent produces for a successful execution. */
export interface AgentOutput {
  /** JSON-serializable result payload, persisted with the task. */
  readonly output: JsonValue;
  /** Human-readable one-line summary used in events and CLI output. */
  readonly summary: string;
}

/**
 * Agent abstraction. Agents are stateless executors identified by name and
 * guarded by capabilities. The orchestrator resolves tasks to agents by name,
 * which keeps agent selection declarative and swappable.
 */
export interface Agent {
  readonly name: string;
  readonly capabilities: readonly string[];
  execute(input: JsonValue, context: AgentContext): Promise<AgentOutput>;
}
