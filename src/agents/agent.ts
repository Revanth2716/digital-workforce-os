import type { Clock, RunId, TaskId } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { ModelInfo } from '../providers/llm-provider.js';
import type { InjectedSkill } from '../skills/skill.js';
import type { RetrievalResult } from '../knowledge/retriever.js';

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
  // ---- Milestone 2: AI agent layer ----
  // Populated by the AI workflow's context factory; the plain
  // orchestrator leaves them undefined, so Milestone 1 agents
  // are unaffected. All fields are immutable snapshots (no
  // global mutable state).
  /** The user objective the current workflow is pursuing. */
  readonly objective?: string;
  /** Outputs of tasks that completed before this one, in completion order. */
  readonly previousResults?: readonly JsonValue[];
  /** Names of every registered tool, for planning and prompting. */
  readonly availableTools?: readonly string[];
  /** Provider/model metadata for the LLM backing the executing agent. */
  readonly model?: ModelInfo;
  // ---- Milestone 3: RAG + Skills ----
  /**
   * Retrieved knowledge chunks for this task. Treated as DATA —
   * never as executable instructions. Populated by the AI
   * workflow when a knowledge store is configured.
   */
  readonly knowledgeContext?: RetrievalResult;
  /**
   * Selected skills for this task. Treated as INSTRUCTIONS —
   * they guide agent behavior but never execute arbitrary
   * commands. Populated by the AI workflow when skills are
   * configured.
   */
  readonly skillContext?: readonly InjectedSkill[];
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
