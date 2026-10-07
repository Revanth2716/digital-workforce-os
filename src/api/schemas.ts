/**
 * API request/response schemas (Milestone 5-A).
 *
 * Zod schemas validate every request body and query string at the
 * HTTP boundary. Response shapes are described here too so
 * handlers stay transport-only and the contract is reviewable in
 * one place.
 *
 * No schema contains a secret, credential or API key.
 */

import { z } from 'zod';

/** Structured error body returned for every non-2xx response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    /** Stable machine-readable code. */
    code: z.string(),
    /** Human-readable summary. Never contains a secret. */
    message: z.string(),
    /** Optional field-level validation details. */
    details: z.array(z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** GET /health */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  /** True when running fully offline with the deterministic provider. */
  deterministic: z.boolean(),
  uptimeMs: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** POST /api/workflows */
export const CreateWorkflowRequestSchema = z.object({
  /** The objective the workflow pursues. */
  objective: z.string().min(1, 'objective must not be empty').max(4000),
  /** Optional display name. */
  name: z.string().min(1).max(200).optional(),
  /** Maximum automatic repair cycles. Bounded so a request can never loop. */
  maxRepairCycles: z.number().int().min(0).max(1).optional(),
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

/** POST /api/workflows response */
export const WorkflowCreatedResponseSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  objective: z.string(),
  status: z.enum(['succeeded', 'failed']),
  repairs: z.number(),
  durationMs: z.number(),
  phaseCount: z.number(),
  summary: z.record(z.string(), z.unknown()),
});
export type WorkflowCreatedResponse = z.infer<typeof WorkflowCreatedResponseSchema>;

/** GET /api/runs */
export const ListRunsResponseSchema = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  count: z.number(),
});
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;

/** GET /api/runs/:id */
export const GetRunResponseSchema = z.object({
  run: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    error: z.string().optional(),
    metadata: z.string().optional(),
  }),
  tasks: z.array(z.record(z.string(), z.unknown())),
  counters: z.object({
    events: z.number(),
    evidence: z.number(),
  }),
  durationMs: z.number().nullable(),
});
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;

/** GET /api/runs/:id/events */
export const ListEventsResponseSchema = z.object({
  runId: z.string(),
  events: z.array(
    z.object({
      seq: z.number(),
      eventId: z.string(),
      type: z.string(),
      taskId: z.string().optional(),
      occurredAt: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  count: z.number(),
  /** Present when the result was truncated by a limit. */
  truncated: z.boolean(),
});
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;

/** GET /api/runs/:id/evidence */
export const ListEvidenceResponseSchema = z.object({
  runId: z.string(),
  evidence: z.array(
    z.object({
      evidenceId: z.string(),
      kind: z.string(),
      createdAt: z.string(),
      data: z.record(z.string(), z.unknown()),
      hash: z.string(),
    }),
  ),
  count: z.number(),
});
export type ListEvidenceResponse = z.infer<typeof ListEvidenceResponseSchema>;

/** GET /api/runs/:id/evaluation */
export const GetEvaluationResponseSchema = z.object({
  runId: z.string(),
  testCaseId: z.string(),
  testCaseName: z.string(),
  passed: z.boolean(),
  score: z.number(),
  failures: z.array(z.string()),
  metrics: z.array(
    z.object({
      name: z.string(),
      score: z.number(),
      passed: z.boolean(),
      explanation: z.string(),
    }),
  ),
  evidenceCount: z.number(),
});
export type GetEvaluationResponse = z.infer<typeof GetEvaluationResponseSchema>;

/**
 * GET /api/runs/:id/metrics
 *
 * Token and count fields are nullable: `null` means the value was
 * never observed (for example a provider that reports no usage),
 * which is deliberately distinct from `0`.
 */
export const GetMetricsResponseSchema = z.object({
  runId: z.string(),
  durationMs: z.number().nullable(),
  agentDurationMs: z.number().nullable(),
  toolCallCount: z.number().nullable(),
  errorCount: z.number().nullable(),
  retryCount: z.number().nullable(),
  policyDenialCount: z.number().nullable(),
  repairCount: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  /** False when no provider reported token usage. */
  tokenUsageAvailable: z.boolean(),
  raw: z.array(
    z.object({
      name: z.string(),
      value: z.number(),
      count: z.number(),
    }),
  ),
  spans: z.array(
    z.object({
      spanId: z.string(),
      name: z.string(),
      status: z.string(),
      kind: z.string(),
      durationMs: z.number().optional(),
      agent: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
  ),
});
export type GetMetricsResponse = z.infer<typeof GetMetricsResponseSchema>;

/** POST /api/workflows/:id/approve and /reject */
export const ApprovalActionRequestSchema = z.object({
  actionType: z.enum(['COMMIT', 'PUSH', 'CREATE_PR', 'EXECUTE_SAFE_COMMAND']).optional(),
  description: z.string().min(1).max(2000).optional(),
  comment: z.string().max(2000).optional(),
  /** Request id, when resolving a previously submitted request. */
  requestId: z.string().min(1).max(200).optional(),
});
/**
 * Body accepted by the approve/reject endpoints. Named to avoid
 * colliding with the domain `ApprovalRequest` type.
 */
export type ApprovalActionRequest = z.infer<typeof ApprovalActionRequestSchema>;

export const ApprovalResponseSchema = z.object({
  requestId: z.string(),
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED']),
  actionType: z.string().optional(),
  comment: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

/** Shared query parameters for list endpoints. */
export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  type: z.string().min(1).max(100).optional(),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

/**
 * Validate an unknown value against a schema, returning either the
 * parsed value or a list of human-readable issues.
 */
export function parseOrIssues<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { ok: true; value: T } | { ok: false; issues: string[] } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}