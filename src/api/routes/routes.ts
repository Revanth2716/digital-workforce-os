/**
 * API routes (Milestone 5-A).
 *
 * Handlers are transport-only: parse input, call an application
 * service, shape the response. There is no orchestration,
 * persistence or policy logic in this file.
 */

import type { Hono } from 'hono';
import type { ApprovalService } from '../../application/approval-service.js';
import type { EvaluationService } from '../../application/evaluation-service.js';
import type { RunService } from '../../application/run-service.js';
import type { WorkflowService } from '../../application/workflow-service.js';
import type { LLMProvider } from '../../providers/llm-provider.js';
import { RunNotFoundError } from '../../core/errors.js';
import {
  ApprovalActionRequestSchema,
  CreateWorkflowRequestSchema,
  ListQuerySchema,
  parseOrIssues,
} from '../schemas.js';
import { fail, ok } from './responses.js';

/** Everything the routes need. */
export interface RouteDeps {
  readonly runs: RunService;
  readonly workflows: WorkflowService;
  readonly approvals: ApprovalService;
  readonly evaluation: EvaluationService;
  readonly llm: LLMProvider;
  readonly serviceName: string;
  readonly version: string;
  readonly startedAt: number;
  readonly now: () => number;
}

/** Register every route on the app. */
export function registerRoutes(app: Hono, deps: RouteDeps): void {
  const { runs, workflows, approvals, evaluation } = deps;

  // ---- GET /health ----
  app.get('/health', (c) =>
    ok(c, {
      status: 'ok' as const,
      service: deps.serviceName,
      version: deps.version,
      // The default provider is fully offline, so the API is too.
      deterministic: deps.llm.name === 'deterministic',
      uptimeMs: Math.max(0, deps.now() - deps.startedAt),
    }),
  );

  // ---- GET /api/stats ----
  // Aggregate dashboard figures, computed server-side so the UI does
  // not need one metrics request per run.
  app.get('/api/stats', (c) => {
    const stats = runs.getStats();
    return ok(c, { ...stats, pendingApprovals: approvals.listPending().length });
  });

  // ---- GET /api/approvals ----
  // Pending approval requests, optionally scoped to one run.
  app.get('/api/approvals', (c) => {
    const runId = c.req.query('runId');
    const pending = runId !== undefined ? approvals.listPendingForRun(runId) : approvals.listPending();
    return ok(c, {
      approvals: pending.map((request) => ({
        requestId: request.id,
        actionType: request.actionType,
        description: request.description,
        status: request.status,
        createdAt: new Date(request.createdAt).toISOString(),
        runId: approvals.runIdForRequest(request.id) ?? null,
      })),
      count: pending.length,
    });
  });

  // ---- GET /api/runs ----
  app.get('/api/runs', (c) => {
    const parsed = parseOrIssues(ListQuerySchema, c.req.query());
    if (!parsed.ok) {
      return fail(c, 400, 'invalid_query', 'Invalid query parameters', parsed.issues);
    }
    const list = runs.listRuns(parsed.value.limit ?? 100);
    return ok(c, {
      // Duration, evaluation score and approval state are joined in
      // here so the run table renders from one request.
      runs: list.map((run) => {
        const evaluationView = evaluation.evaluateRun(run.id);
        const approvalState = approvals.getStateForRun(run.id);
        return {
          ...run,
          durationMs: runs.getRunDurationMs(run.id),
          evaluationScore: evaluationView.score,
          evaluationPassed: evaluationView.passed,
          approvalState: approvalState.status,
          ...(approvalState.status === 'APPROVED' || approvalState.status === 'REJECTED'
            ? { approvalRequestId: approvalState.requestId }
            : {}),
        };
      }),
      count: list.length,
    });
  });

  // ---- GET /api/runs/:id ----
  app.get('/api/runs/:id', (c) => {
    const runId = c.req.param('id');
    const run = runs.findRun(runId);
    if (run === undefined) {
      return fail(c, 404, 'run_not_found', `Run not found: ${runId}`);
    }
    return ok(c, {
      run,
      tasks: runs.getTasks(runId),
      counters: runs.getCounters(runId),
      durationMs: runs.getRunDurationMs(runId),
    });
  });

  // ---- GET /api/runs/:id/events ----
  app.get('/api/runs/:id/events', (c) => {
    const runId = c.req.param('id');
    const parsed = parseOrIssues(ListQuerySchema, c.req.query());
    if (!parsed.ok) {
      return fail(c, 400, 'invalid_query', 'Invalid query parameters', parsed.issues);
    }
    if (runs.findRun(runId) === undefined) {
      return fail(c, 404, 'run_not_found', `Run not found: ${runId}`);
    }

    const limit = parsed.value.limit;
    const events = runs.getEvents(runId, {
      ...(parsed.value.type !== undefined ? { type: parsed.value.type } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    return ok(c, {
      runId,
      events,
      count: events.length,
      // More events exist than were returned when a limit applied.
      truncated: limit !== undefined && runs.getCounters(runId).events > events.length,
    });
  });

  // ---- GET /api/runs/:id/evidence ----
  app.get('/api/runs/:id/evidence', (c) => {
    const runId = c.req.param('id');
    const parsed = parseOrIssues(ListQuerySchema, c.req.query());
    if (!parsed.ok) {
      return fail(c, 400, 'invalid_query', 'Invalid query parameters', parsed.issues);
    }
    if (runs.findRun(runId) === undefined) {
      return fail(c, 404, 'run_not_found', `Run not found: ${runId}`);
    }

    const evidence = runs.getEvidence(runId, parsed.value.limit ?? 1000);
    return ok(c, { runId, evidence, count: evidence.length });
  });

  // ---- GET /api/runs/:id/evaluation ----
  app.get('/api/runs/:id/evaluation', (c) => {
    const runId = c.req.param('id');
    if (runs.findRun(runId) === undefined) {
      return fail(c, 404, 'run_not_found', `Run not found: ${runId}`);
    }
    return ok(c, evaluation.evaluateRun(runId, c.req.query('testCase')));
  });

  // ---- GET /api/runs/:id/metrics ----
  app.get('/api/runs/:id/metrics', (c) => {
    const runId = c.req.param('id');
    if (runs.findRun(runId) === undefined) {
      return fail(c, 404, 'run_not_found', `Run not found: ${runId}`);
    }
    const metrics = runs.getMetrics(runId);
    return ok(c, {
      runId: metrics.runId,
      durationMs: metrics.durationMs,
      agentDurationMs: metrics.agentDurationMs,
      toolCallCount: metrics.toolCallCount,
      errorCount: metrics.errorCount,
      retryCount: metrics.retryCount,
      policyDenialCount: metrics.policyDenialCount,
      repairCount: metrics.repairCount,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      // Explicitly flag unavailable token data rather than
      // presenting null as if it were zero.
      tokenUsageAvailable: metrics.totalTokens !== null,
      raw: metrics.raw.map((metric) => ({
        name: metric.name,
        value: metric.value,
        count: metric.count,
      })),
      spans: metrics.spans.map((span) => ({
        spanId: span.spanId,
        name: span.name,
        status: span.status,
        kind: span.kind,
        ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
        ...(span.agent !== undefined ? { agent: span.agent } : {}),
        ...(span.provider !== undefined ? { provider: span.provider } : {}),
        ...(span.model !== undefined ? { model: span.model } : {}),
      })),
    });
  });

  // ---- POST /api/workflows ----
  app.post('/api/workflows', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'invalid_json', 'Request body must be valid JSON');
    }

    const parsed = parseOrIssues(CreateWorkflowRequestSchema, body);
    if (!parsed.ok) {
      return fail(c, 422, 'validation_failed', 'Request validation failed', parsed.issues);
    }

    try {
      const result = await workflows.executeRun(parsed.value.objective, {
        ...(parsed.value.maxRepairCycles !== undefined
          ? { maxRepairCycles: parsed.value.maxRepairCycles }
          : {}),
      });
      return ok(c, result, 201);
    } catch (error) {
      // The engine failed: surface it as a structured 500 rather
      // than leaking a stack trace.
      return fail(
        c,
        500,
        'workflow_failed',
        error instanceof Error ? error.message : 'Workflow execution failed',
      );
    }
  });

  // ---- POST /api/workflows/:id/approve ----
  app.post('/api/workflows/:id/approve', async (c) => {
    const runId = c.req.param('id');
    const body = await readOptionalJson(c.req.raw);
    const parsed = parseOrIssues(ApprovalActionRequestSchema, body);
    if (!parsed.ok) {
      return fail(c, 422, 'validation_failed', 'Request validation failed', parsed.issues);
    }

    try {
      // Resolving an existing request, or submitting a new one and
      // approving it immediately.
      const requestId =
        parsed.value.requestId ??
        approvals.submit({
          actionType: parsed.value.actionType ?? 'COMMIT',
          description: parsed.value.description ?? `approve workflow ${runId}`,
          runId,
        }).requestId;

      const resolution = approvals.approve(requestId, parsed.value.comment);
      return ok(c, {
        requestId: resolution.requestId,
        status: resolution.decision,
        ...(resolution.comment !== undefined ? { comment: resolution.comment } : {}),
      });
    } catch (error) {
      return fail(
        c,
        409,
        'approval_failed',
        error instanceof Error ? error.message : 'Approval failed',
      );
    }
  });

  // ---- POST /api/workflows/:id/reject ----
  app.post('/api/workflows/:id/reject', async (c) => {
    const runId = c.req.param('id');
    const body = await readOptionalJson(c.req.raw);
    const parsed = parseOrIssues(ApprovalActionRequestSchema, body);
    if (!parsed.ok) {
      return fail(c, 422, 'validation_failed', 'Request validation failed', parsed.issues);
    }

    try {
      const requestId =
        parsed.value.requestId ??
        approvals.submit({
          actionType: parsed.value.actionType ?? 'COMMIT',
          description: parsed.value.description ?? `reject workflow ${runId}`,
          runId,
        }).requestId;

      const resolution = approvals.reject(requestId, parsed.value.comment);
      return ok(c, {
        requestId: resolution.requestId,
        status: resolution.decision,
        ...(resolution.comment !== undefined ? { comment: resolution.comment } : {}),
      });
    } catch (error) {
      return fail(
        c,
        409,
        'approval_failed',
        error instanceof Error ? error.message : 'Rejection failed',
      );
    }
  });
}

/** Read an optional JSON body, tolerating an empty body. */
async function readOptionalJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text.trim().length === 0) return {};
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** Re-exported so route tests can assert the domain error shape. */
export { RunNotFoundError };