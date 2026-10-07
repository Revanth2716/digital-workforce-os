/**
 * API data shapes (M5-B).
 *
 * These mirror the response contracts declared in the backend
 * `src/api/schemas.ts`. They are hand-written rather than
 * generated so the dashboard stays buildable on its own with no
 * cross-package build step, and `client.test.ts` asserts the
 * shapes line up with real API responses.
 *
 * Every numeric field the backend may report as "unavailable" is
 * typed `number | null`. The UI renders those as "N/A" and never
 * substitutes a zero.
 */

/** A run as listed by `GET /api/runs`. */
export interface RunSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  /** Null when the run has not completed or timings are absent. */
  readonly durationMs: number | null;
  /** Null when the run could not be evaluated. */
  readonly evaluationScore: number | null;
  readonly evaluationPassed: boolean;
  readonly approvalState: 'NONE' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly approvalRequestId?: string;
}

export interface ListRunsResponse {
  readonly runs: readonly RunSummary[];
  readonly count: number;
}

/** A task row as returned by `GET /api/runs/:id`. */
export interface RunTask {
  readonly id: string;
  readonly task_name: string;
  readonly agent: string;
  readonly status: string;
  readonly attempts: number;
  readonly error?: string | null;
}

export interface GetRunResponse {
  readonly run: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly error?: string;
    readonly metadata?: string;
  };
  readonly tasks: readonly RunTask[];
  readonly counters: { readonly events: number; readonly evidence: number };
  readonly durationMs: number | null;
}

/** A raw event from `GET /api/runs/:id/events`. */
export interface RunEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly taskId?: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ListEventsResponse {
  readonly runId: string;
  readonly events: readonly RunEvent[];
  readonly count: number;
  readonly truncated: boolean;
}

/** An evidence record from `GET /api/runs/:id/evidence`. */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly hash: string;
}

export interface ListEvidenceResponse {
  readonly runId: string;
  readonly evidence: readonly EvidenceRecord[];
  readonly count: number;
}

/** One evaluation metric. */
export interface EvaluationMetric {
  readonly name: string;
  readonly score: number;
  readonly passed: boolean;
  readonly explanation: string;
}

export interface GetEvaluationResponse {
  readonly runId: string;
  readonly testCaseId: string;
  readonly testCaseName: string;
  readonly passed: boolean;
  readonly score: number;
  readonly failures: readonly string[];
  readonly metrics: readonly EvaluationMetric[];
  readonly evidenceCount: number;
}

/** Observability metrics from `GET /api/runs/:id/metrics`. */
export interface RunMetrics {
  readonly runId: string;
  readonly durationMs: number | null;
  readonly agentDurationMs: number | null;
  readonly toolCallCount: number | null;
  readonly errorCount: number | null;
  readonly retryCount: number | null;
  readonly policyDenialCount: number | null;
  readonly repairCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** False when no provider reported token usage. */
  readonly tokenUsageAvailable: boolean;
  readonly raw: readonly { readonly name: string; readonly value: number; readonly count: number }[];
  readonly spans: readonly {
    readonly spanId: string;
    readonly name: string;
    readonly status: string;
    readonly kind: string;
    readonly durationMs?: number;
    readonly agent?: string;
    readonly provider?: string;
    readonly model?: string;
  }[];
}

/** Aggregate figures from `GET /api/stats`. */
export interface RunStats {
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly runningRuns: number;
  readonly averageDurationMs: number | null;
  readonly totalToolCalls: number | null;
  readonly totalErrors: number | null;
  readonly tokenUsageAvailable: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly pendingApprovals: number;
}

/** A pending approval from `GET /api/approvals`. */
export interface PendingApproval {
  readonly requestId: string;
  readonly actionType: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: string;
  readonly runId: string | null;
}

export interface ListApprovalsResponse {
  readonly approvals: readonly PendingApproval[];
  readonly count: number;
}

/** Result of an approve/reject call. */
export interface ApprovalResult {
  readonly requestId: string;
  readonly status: 'APPROVED' | 'REJECTED';
  readonly comment?: string;
}

export interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly version: string;
  readonly deterministic: boolean;
  readonly uptimeMs: number;
}

export interface CreateWorkflowResponse {
  readonly runId: string;
  readonly workflowId: string;
  readonly objective: string;
  readonly status: 'succeeded' | 'failed';
  readonly repairs: number;
  readonly durationMs: number;
  readonly phaseCount: number;
  readonly summary: Readonly<Record<string, unknown>>;
}