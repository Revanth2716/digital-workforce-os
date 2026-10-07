/**
 * Typed API client (M5-B).
 *
 * A thin `fetch` wrapper over the local REST API. It owns exactly
 * three concerns and nothing else:
 *
 *   - URL construction,
 *   - the structured `{ error: { code, message, details } }`
 *     envelope becoming a typed `ApiError`,
 *   - response shape validation for the endpoints the dashboard
 *     depends on, so a backend contract change surfaces as a clear
 *     error instead of `undefined` deep inside a component.
 *
 * It contains no business logic: aggregation, scoring and approval
 * decisions all stay on the server.
 */

import type {
  ApprovalResult,
  CreateWorkflowResponse,
  GetEvaluationResponse,
  GetRunResponse,
  HealthResponse,
  ListApprovalsResponse,
  ListEvidenceResponse,
  ListEventsResponse,
  ListRunsResponse,
  PendingApproval,
  RunMetrics,
  RunStats,
  RunSummary,
} from './types';

/** A structured API failure, carrying the backend's stable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[];

  constructor(status: number, code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when retrying the same request might succeed. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/** Raised when a response does not match the expected contract. */
export class ResponseShapeError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'ResponseShapeError';
    this.issues = issues;
  }
}

/** Injectable fetch, so tests can drive the client without a server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to a same-origin relative base. */
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Defaults to 15000. */
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assert a response is an object with the given keys present.
 *
 * Deliberately shallow: it catches contract drift (a renamed or
 * missing field) without pulling in a schema library, which would
 * add runtime weight to the bundle for no functional gain.
 */
function requireShape(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ResponseShapeError(`${context}: expected an object, got ${typeof value}`);
  }
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new ResponseShapeError(`${context}: missing field(s) ${missing.join(', ')}`, missing);
  }
  return value;
}

/** Typed client for the local Digital Workforce OS API. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    const provided = options.fetchImpl;
    this.fetchImpl =
      provided ??
      ((input, init) => {
        if (typeof globalThis.fetch !== 'function') {
          return Promise.reject(
            new ApiError(0, 'fetch_unavailable', 'fetch is not available in this environment'),
          );
        }
        return globalThis.fetch(input, init);
      });
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Issue a request and decode a JSON body, mapping failures to ApiError. */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    context = path,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    // A timeout keeps a stalled local server from hanging the UI
    // forever; status 0 marks it as retryable.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, 'network_error', `Cannot reach the API at ${url}: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        `${context}: response body was not valid JSON`,
      );
    }

    if (!response.ok) {
      // The backend always uses the structured error envelope.
      if (isRecord(body) && isRecord(body['error'])) {
        const error = body['error'];
        const details = Array.isArray(error['details'])
          ? (error['details'] as unknown[]).map(String)
          : [];
        throw new ApiError(
          response.status,
          typeof error['code'] === 'string' ? error['code'] : 'unknown_error',
          typeof error['message'] === 'string' ? error['message'] : 'Request failed',
          details,
        );
      }
      throw new ApiError(response.status, 'unknown_error', `${context}: request failed`);
    }

    return body as T;
  }

  // ---- Read endpoints ----

  async health(): Promise<HealthResponse> {
    const body = await this.request<unknown>('/health', {}, 'GET /health');
    return requireShape(body, ['status', 'service', 'version'], 'GET /health') as unknown as HealthResponse;
  }

  async listRuns(): Promise<ListRunsResponse> {
    const body = await this.request<unknown>('/api/runs', {}, 'GET /api/runs');
    const shaped = requireShape(body, ['runs', 'count'], 'GET /api/runs');
    if (!Array.isArray(shaped['runs'])) {
      throw new ResponseShapeError('GET /api/runs: `runs` must be an array');
    }
    return shaped as unknown as ListRunsResponse;
  }

  async getRun(runId: string): Promise<GetRunResponse> {
    const body = await this.request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}`,
      {},
      'GET /api/runs/:id',
    );
    return requireShape(
      body,
      ['run', 'tasks', 'counters', 'durationMs'],
      'GET /api/runs/:id',
    ) as unknown as GetRunResponse;
  }

  async getEvents(runId: string): Promise<ListEventsResponse> {
    const body = await this.request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/events`,
      {},
      'GET /api/runs/:id/events',
    );
    const shaped = requireShape(body, ['runId', 'events', 'count'], 'GET /api/runs/:id/events');
    if (!Array.isArray(shaped['events'])) {
      throw new ResponseShapeError('GET /api/runs/:id/events: `events` must be an array');
    }
    return shaped as unknown as ListEventsResponse;
  }

  async getEvidence(runId: string): Promise<ListEvidenceResponse> {
    const body = await this.request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/evidence`,
      {},
      'GET /api/runs/:id/evidence',
    );
    const shaped = requireShape(body, ['runId', 'evidence', 'count'], 'GET /api/runs/:id/evidence');
    if (!Array.isArray(shaped['evidence'])) {
      throw new ResponseShapeError('GET /api/runs/:id/evidence: `evidence` must be an array');
    }
    return shaped as unknown as ListEvidenceResponse;
  }

  async getEvaluation(runId: string): Promise<GetEvaluationResponse> {
    const body = await this.request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/evaluation`,
      {},
      'GET /api/runs/:id/evaluation',
    );
    return requireShape(
      body,
      ['runId', 'testCaseId', 'passed', 'score', 'metrics'],
      'GET /api/runs/:id/evaluation',
    ) as unknown as GetEvaluationResponse;
  }

  async getMetrics(runId: string): Promise<RunMetrics> {
    const body = await this.request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/metrics`,
      {},
      'GET /api/runs/:id/metrics',
    );
    return requireShape(
      body,
      ['runId', 'durationMs', 'tokenUsageAvailable'],
      'GET /api/runs/:id/metrics',
    ) as unknown as RunMetrics;
  }

  async getStats(): Promise<RunStats> {
    const body = await this.request<unknown>('/api/stats', {}, 'GET /api/stats');
    return requireShape(body, ['totalRuns', 'successfulRuns', 'failedRuns'], 'GET /api/stats') as unknown as RunStats;
  }

  async listApprovals(runId?: string): Promise<ListApprovalsResponse> {
    const query = runId !== undefined ? `?runId=${encodeURIComponent(runId)}` : '';
    const body = await this.request<unknown>(
      `/api/approvals${query}`,
      {},
      'GET /api/approvals',
    );
    const shaped = requireShape(body, ['approvals', 'count'], 'GET /api/approvals');
    if (!Array.isArray(shaped['approvals'])) {
      throw new ResponseShapeError('GET /api/approvals: `approvals` must be an array');
    }
    return shaped as unknown as ListApprovalsResponse;
  }

  // ---- Write endpoints ----

  async createWorkflow(objective: string): Promise<CreateWorkflowResponse> {
    const body = await this.request<unknown>(
      '/api/workflows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective }),
      },
      'POST /api/workflows',
    );
    return requireShape(
      body,
      ['runId', 'status', 'objective'],
      'POST /api/workflows',
    ) as unknown as CreateWorkflowResponse;
  }

  /**
   * Approve a workflow.
   *
   * Delegates entirely to the backend approval service — the UI
   * never decides an approval outcome locally.
   */
  async approve(runId: string, requestId?: string): Promise<ApprovalResult> {
    return this.resolveApproval(runId, 'approve', requestId);
  }

  /** Reject a workflow, delegating to the backend approval service. */
  async reject(runId: string, requestId?: string): Promise<ApprovalResult> {
    return this.resolveApproval(runId, 'reject', requestId);
  }

  private async resolveApproval(
    runId: string,
    action: 'approve' | 'reject',
    requestId?: string,
  ): Promise<ApprovalResult> {
    const body = await this.request<unknown>(
      `/api/workflows/${encodeURIComponent(runId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestId !== undefined ? { requestId } : {}),
      },
      `POST /api/workflows/:id/${action}`,
    );
    return requireShape(body, ['requestId', 'status'], `POST /api/workflows/:id/${action}`) as unknown as ApprovalResult;
  }
}

/** Convenience factory used by the app. */
export function createApiClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

/** Re-exported so components can narrow without importing types.ts. */
export type { RunSummary, PendingApproval };