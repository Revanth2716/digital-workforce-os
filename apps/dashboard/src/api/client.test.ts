/**
 * API client tests (M5-B).
 *
 * Drives the client with a stub `fetch`, so no server, no browser
 * and no network are involved.
 */

import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, ResponseShapeError } from './client';
import type { FetchLike } from './client';

interface StubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Build a fetch stub returning the given JSON responses in order. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response === undefined) {
      throw new Error('stub exhausted');
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as unknown as Response;
  };

  return { fetchImpl, calls };
}

function clientWith(responses: Array<{ status: number; body: unknown }>): {
  client: ApiClient;
  calls: StubCall[];
} {
  const { fetchImpl, calls } = stubFetch(responses);
  return { client: new ApiClient({ fetchImpl }), calls };
}

describe('ApiClient — successful reads', () => {
  it('reads health', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          status: 'ok',
          service: 'digital-workforce-os',
          version: '0.5.0',
          deterministic: true,
          uptimeMs: 12,
        },
      },
    ]);

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.deterministic).toBe(true);
  });

  it('reads the run list', async () => {
    const { client, calls } = clientWith([
      { status: 200, body: { runs: [{ id: 'run-1', name: 'test' }], count: 1 } },
    ]);

    const response = await client.listRuns();
    expect(response.count).toBe(1);
    expect(calls[0]?.url).toBe('/api/runs');
  });

  it('encodes run ids into the path', async () => {
    const { client, calls } = clientWith([
      {
        status: 200,
        body: {
          run: { id: 'a b' },
          tasks: [],
          counters: { events: 0, evidence: 0 },
          durationMs: null,
        },
      },
    ]);

    await client.getRun('a b');
    expect(calls[0]?.url).toBe('/api/runs/a%20b');
  });

  it('prefixes a configured base url', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { runs: [], count: 0 } }]);
    const client = new ApiClient({ fetchImpl, baseUrl: 'http://127.0.0.1:4317/' });

    await client.listRuns();
    expect(calls[0]?.url).toBe('http://127.0.0.1:4317/api/runs');
  });

  it('reads metrics', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          runId: 'r',
          durationMs: 100,
          agentDurationMs: null,
          toolCallCount: 3,
          errorCount: 0,
          retryCount: null,
          policyDenialCount: null,
          repairCount: 1,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          tokenUsageAvailable: false,
          raw: [],
          spans: [],
        },
      },
    ]);

    const metrics = await client.getMetrics('r');
    // Unavailable values survive as null, not 0.
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.tokenUsageAvailable).toBe(false);
    expect(metrics.toolCallCount).toBe(3);
  });
});

describe('ApiClient — error handling', () => {
  it('maps the structured error envelope to ApiError', async () => {
    const { client } = clientWith([
      {
        status: 404,
        body: { error: { code: 'run_not_found', message: 'Run not found: x' } },
      },
    ]);

    const error = await client.getRun('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('run_not_found');
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).isRetryable).toBe(false);
  });

  it('includes validation details when present', async () => {
    const { client } = clientWith([
      {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'Request validation failed',
            details: ['objective: must not be empty'],
          },
        },
      },
    ]);

    const error = (await client.createWorkflow('').catch((e: unknown) => e)) as ApiError;
    expect(error.details).toEqual(['objective: must not be empty']);
  });

  it('treats 5xx as retryable', async () => {
    const { client } = clientWith([
      { status: 500, body: { error: { code: 'internal_error', message: 'boom' } } },
    ]);

    const error = (await client.getStats().catch((e: unknown) => e)) as ApiError;
    expect(error.isRetryable).toBe(true);
  });

  it('wraps a transport failure as a retryable network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('connection refused');
    };
    const client = new ApiClient({ fetchImpl });

    const error = (await client.health().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
    expect(error.isRetryable).toBe(true);
  });

  it('reports a non-JSON body as invalid_response', async () => {
    const fetchImpl: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }) as unknown as Response;
    const client = new ApiClient({ fetchImpl });

    const error = (await client.health().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('invalid_response');
  });

  it('falls back when the error envelope is missing', async () => {
    const { client } = clientWith([{ status: 500, body: { unexpected: true } }]);

    const error = (await client.getStats().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('unknown_error');
  });
});

describe('ApiClient — response shape validation', () => {
  it('rejects a response missing required fields', async () => {
    const { client } = clientWith([{ status: 200, body: { runId: 'r' } }]);

    const error = (await client.getMetrics('r').catch((e: unknown) => e)) as unknown;
    expect(error).toBeInstanceOf(ResponseShapeError);
  });

  it('rejects a non-object body', async () => {
    const { client } = clientWith([{ status: 200, body: 'not an object' }]);

    await expect(client.listRuns()).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('rejects a list whose array field is not an array', async () => {
    const { client } = clientWith([{ status: 200, body: { runs: 'nope', count: 0 } }]);

    await expect(client.listRuns()).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('names the missing fields', async () => {
    const { client } = clientWith([{ status: 200, body: {} }]);

    const error = (await client.health().catch((e: unknown) => e)) as ResponseShapeError;
    expect(error.issues.length).toBeGreaterThan(0);
  });
});

describe('ApiClient — approval actions', () => {
  it('posts an approve request', async () => {
    const { client, calls } = clientWith([
      { status: 200, body: { requestId: 'req-1', status: 'APPROVED' } },
    ]);

    const result = await client.approve('run-1');
    expect(result.status).toBe('APPROVED');

    const call = calls[0]!;
    expect(call.url).toBe('/api/workflows/run-1/approve');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('posts a reject request', async () => {
    const { client, calls } = clientWith([
      { status: 200, body: { requestId: 'req-1', status: 'REJECTED' } },
    ]);

    const result = await client.reject('run-1', 'req-1');
    expect(result.status).toBe('REJECTED');
    expect(calls[0]?.url).toBe('/api/workflows/run-1/reject');
    // The request id is forwarded so the backend resolves the
    // specific pending request.
    expect(String(calls[0]?.init?.body)).toContain('req-1');
  });

  it('surfaces an approval conflict', async () => {
    const { client } = clientWith([
      {
        status: 409,
        body: { error: { code: 'approval_failed', message: 'No pending approval request' } },
      },
    ]);

    const error = (await client.approve('run-1').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(409);
    expect(error.code).toBe('approval_failed');
  });
});

describe('ApiClient — workflow creation', () => {
  it('posts the objective as JSON', async () => {
    const { client, calls } = clientWith([
      {
        status: 201,
        body: {
          runId: 'run-1',
          workflowId: 'run-1',
          objective: 'do a thing',
          status: 'succeeded',
          repairs: 1,
          durationMs: 50,
          phaseCount: 6,
          summary: {},
        },
      },
    ]);

    const created = await client.createWorkflow('do a thing');
    expect(created.runId).toBe('run-1');

    const body = JSON.parse(String(calls[0]?.init?.body)) as { objective: string };
    expect(body.objective).toBe('do a thing');
  });
});