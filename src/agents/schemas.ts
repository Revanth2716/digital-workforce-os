import { z } from 'zod';

// ---------------------------------------------------------------------------
// Milestone 2 structured schemas.
//
// Every model-generated structured output in the AI agent layer is
// validated against one of these schemas before it is trusted,
// persisted or forwarded to another agent. Validation happens at
// three layers: the LLM provider (before a completion is returned),
// the agent (before a result is returned to the orchestrator) and
// the AI workflow (before a task output is consumed).
// ---------------------------------------------------------------------------

/** A request to invoke a tool, produced by a model. */
export const ToolCallRequestSchema = z.object({
  /** Correlates a request with its result. */
  id: z.string().min(1),
  /** Name of the registered tool to invoke. */
  tool: z.string().min(1),
  /** Arguments validated against the tool's declared input schema. */
  arguments: z.record(z.string(), z.unknown()),
});

/** The outcome of a single tool invocation. */
export const ToolCallResultSchema = z.object({
  /** Mirrors the originating ToolCallRequest id. */
  id: z.string().min(1),
  tool: z.string().min(1),
  ok: z.boolean(),
  /** Tool output, present when `ok` is true. */
  output: z.unknown().optional(),
  /** Error description, present when `ok` is false. */
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/** One unit of work in an agent plan. */
export const PlannedTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Registered agent that executes this task. */
  assignedAgent: z.enum(['researcher', 'builder', 'verifier']),
  /** Tools the task needs, by registry name. */
  tools: z.array(z.string().min(1)).default([]),
  /** Ids of other plan tasks that must complete first. */
  dependsOn: z.array(z.string().min(1)).default([]),
  /** What "done" looks like for this task. */
  expectedOutcome: z.string().min(1),
});

/** A validated plan produced by the planner agent. */
export const AgentPlanSchema = z.object({
  objective: z.string().min(1),
  summary: z.string().min(1),
  tasks: z.array(PlannedTaskSchema).min(1),
});

/** Structured findings produced by the researcher agent. */
export const ResearchFindingsSchema = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)).min(1),
  sources: z.array(z.string().min(1)).default([]),
});

/**
 * The researcher agent's model output: findings plus any
 * read-only tool calls it wants to execute.
 */
export const ResearchOutputSchema = ResearchFindingsSchema.extend({
  taskId: z.string().min(1),
  toolCallRequests: z.array(ToolCallRequestSchema).default([]),
});

/**
 * The researcher agent's final, tool-enriched result:
 * findings plus the executed tool call results.
 */
export const ResearchResultSchema = ResearchFindingsSchema.extend({
  taskId: z.string().min(1),
  toolCalls: z.array(ToolCallResultSchema).default([]),
});

/** The builder agent's model output, before tools run. */
export const BuilderOutputSchema = z.object({
  summary: z.string().min(1),
  artifacts: z.array(z.string().min(1)).default([]),
  toolCallRequests: z.array(ToolCallRequestSchema).default([]),
});

/**
 * The structured result every completed agent task produces.
 * `artifacts` names the produced artefacts; `toolCalls`
 * carries the executed tool call results as evidence.
 */
export const AgentResultSchema = z.object({
  taskId: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(['succeeded', 'failed']),
  summary: z.string().min(1),
  artifacts: z.array(z.string().min(1)).default([]),
  toolCalls: z.array(ToolCallResultSchema).default([]),
});

/** A single issue found during verification. */
export const VerificationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
});

/** The verifier agent's pass/fail decision with structured failure information. */
export const VerificationResultSchema = z.object({
  passed: z.boolean(),
  summary: z.string().min(1),
  score: z.number().min(0).max(100).optional(),
  issues: z.array(VerificationIssueSchema).default([]),
  /** References into the evidence log supporting the verdict. */
  evidence: z.array(z.string().min(1)).default([]),
});

// ---- Inferred types ---------------------------------------------------------

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type ResearchFindings = z.infer<typeof ResearchFindingsSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export type BuilderOutput = z.infer<typeof BuilderOutputSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type VerificationIssue = z.infer<typeof VerificationIssueSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ---- Validation helper ------------------------------------------------------

export interface StructuredValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface StructuredValidationFailure {
  readonly ok: false;
  readonly issues: readonly string[];
}

export type StructuredValidation<T> =
  | StructuredValidationSuccess<T>
  | StructuredValidationFailure;

/**
 * Validate an unknown value against a structured schema,
 * returning either the parsed value or a human-readable
 * issue list. Used wherever model output is consumed.
 */
export function validateStructured<T>(
  schema: z.ZodType<T>,
  value: unknown,
): StructuredValidation<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
