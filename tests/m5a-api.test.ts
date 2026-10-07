/**
 * REST API tests (Milestone 5-A).
 *
 * Exercises the real HTTP surface against a live server on an
 * ephemeral port, using the deterministic provider. No network
 * access beyond loopback and no credentials are required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposition } from '../src/index.js';
import type { Composition } from '../src/index.js';
import { createApiApp, startApiServer } from '../src/api/server.js';
import type { ApiServerHandle } from '../src/api/server.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import {
  CreateWorkflowRequestSchema,
  HealthResponseSchema,
  ListRunsResponseSchema,
  GetMetricsResponseSchema,
  parseOrIssues,
} from '../src/api/schemas.js';
import { createDemoResponses, AI_DEMO_OBJECTIVE } from '../src/orchestrator/ai-demo.js';

let dir: string;
let composition: Composition;
let server: ApiServerHandle;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dwo-m5a-api-'));
  composition = createComposition({
    dbPath: join(dir, 'api.db'),
    concurrency: 1,
    llmResponses: createDemoResponses(),
    policy: new PolicyEngine(),
  });

  server = await startApiServer({
    runs: composition.runService,
    workflows: composition.workflowService,
    approvals: composition.approvalService,
    evaluation: composition.evaluationService,
    llm: composition.llm,
    host: '127.0.0.1',
    // Port 0 lets the OS pick a free port so tests never collide.
    port: 0,
  });
  base = server.url;
}, 60_000);

afterAll(async () => {
  await server.close();
  composition.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A decoded API response. Bodies are JSON objects. */
interface ApiResponse {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

async function get(path: string): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

async function post(path: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

/** Runs one workflow and returns its id. */
async function createRun(): Promise<string> {
  const created = await post('/api/workflows', { objective: AI_DEMO_OBJECTIVE });
  expect(created.status).toBe(201);
  return created.body.runId as string;
}

describe('API — health', () => {
  it('returns a healthy response', async () => {
    const health = await get('/health');
    expect(health.status).toBe(200);

    // Response validates against its declared schema.
    const parsed = parseOrIssues(HealthResponseSchema, health.body);
    expect(parsed.ok).toBe(true);
    expect(health.body.status).toBe('ok');
    expect(health.body.service).toBe('digital-workforce-os');
  });

  it('reports deterministic (offline) mode', async () => {
    const health = await get('/health');
    expect(health.body.deterministic).toBe(true);
  });
});

describe('API — workflows', () => {
  it('creates and executes a workflow', async () => {
    const created = await post('/api/workflows', { objective: AI_DEMO_OBJECTIVE });

    expect(created.status).toBe(201);
    expect(typeof created.body.runId).toBe('string');
    expect(created.body.status).toBe('succeeded');
    // The demo scenario exercises the bounded repair cycle.
    expect(created.body.repairs).toBe(1);
    expect(created.body.phaseCount).toBeGreaterThan(0);
  });

  it('rejects an empty objective with a structured error', async () => {
    const response = await post('/api/workflows', { objective: '' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.message).toBeTruthy();
    expect(Array.isArray(response.body.error.details)).toBe(true);
  });

  it('rejects a missing objective', async () => {
    const response = await post('/api/workflows', {});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('rejects an unbounded repair count', async () => {
    // maxRepairCycles is capped at 1 so a request can never loop.
    const response = await post('/api/workflows', {
      objective: AI_DEMO_OBJECTIVE,
      maxRepairCycles: 99,
    });
    expect(response.status).toBe(422);
  });

  it('rejects malformed JSON', async () => {
    const response = await fetch(`${base}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('invalid_json');
  });

  it('validates the create-workflow schema', () => {
    const parsed = parseOrIssues(CreateWorkflowRequestSchema, {
      objective: 'do a thing',
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('API — runs', () => {
  it('lists runs', async () => {
    await createRun();
    const response = await get('/api/runs');

    expect(response.status).toBe(200);
    const parsed = parseOrIssues(ListRunsResponseSchema, response.body);
    expect(parsed.ok).toBe(true);
    expect(response.body.count).toBeGreaterThan(0);
  });

  it('gets a single run with its tasks', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}`);

    expect(response.status).toBe(200);
    expect(response.body.run.id).toBe(runId);
    expect(response.body.run.status).toBe('succeeded');
    expect(response.body.tasks.length).toBeGreaterThan(0);
    expect(response.body.counters.events).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown run', async () => {
    const response = await get('/api/runs/missing-run');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('run_not_found');
  });

  it('rejects an out-of-range limit', async () => {
    const response = await get('/api/runs?limit=100000');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_query');
  });
});

describe('API — events and evidence', () => {
  it('returns events for a run', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/events`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBeGreaterThan(0);
    const types = response.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain('task.succeeded');
  });

  it('filters events by type', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/events?type=evidence.recorded`);

    expect(response.status).toBe(200);
    expect(
      response.body.events.every((event: { type: string }) => event.type === 'evidence.recorded'),
    ).toBe(true);
  });

  it('honours the event limit and flags truncation', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/events?limit=2`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBeLessThanOrEqual(2);
    expect(response.body.truncated).toBe(true);
  });

  it('returns 404 for events of an unknown run', async () => {
    const response = await get('/api/runs/missing/events');
    expect(response.status).toBe(404);
  });

  it('returns hash-addressed evidence', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/evidence`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBeGreaterThan(0);
    for (const record of response.body.evidence) {
      expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('returns 404 for evidence of an unknown run', async () => {
    const response = await get('/api/runs/missing/evidence');
    expect(response.status).toBe(404);
  });
});

describe('API — evaluation and metrics', () => {
  it('returns an evaluation for a run', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/evaluation`);

    expect(response.status).toBe(200);
    expect(response.body.runId).toBe(runId);
    expect(typeof response.body.score).toBe('number');
    expect(response.body.metrics.length).toBeGreaterThan(0);
    // Every metric explains itself.
    for (const metric of response.body.metrics) {
      expect(metric.explanation).toBeTruthy();
    }
  });

  it('returns metrics for a run', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/metrics`);

    expect(response.status).toBe(200);
    const parsed = parseOrIssues(GetMetricsResponseSchema, response.body);
    expect(parsed.ok).toBe(true);

    expect(typeof response.body.durationMs).toBe('number');
    expect(response.body.toolCallCount).toBeGreaterThan(0);
    expect(response.body.spans.length).toBeGreaterThan(0);
  });

  it('reports token usage from the deterministic provider', async () => {
    const runId = await createRun();
    const response = await get(`/api/runs/${runId}/metrics`);

    expect(response.body.tokenUsageAvailable).toBe(true);
    expect(typeof response.body.totalTokens).toBe('number');
    expect(response.body.totalTokens).toBeGreaterThan(0);
  });

  it('returns 404 for metrics of an unknown run', async () => {
    const response = await get('/api/runs/missing/metrics');
    expect(response.status).toBe(404);
  });
});

describe('API — approvals', () => {
  it('approves a workflow', async () => {
    const runId = await createRun();
    const response = await post(`/api/workflows/${runId}/approve`, {
      actionType: 'COMMIT',
      description: 'approve the commit',
      comment: 'ok',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.comment).toBe('ok');
  });

  it('rejects a workflow', async () => {
    const runId = await createRun();
    const response = await post(`/api/workflows/${runId}/reject`, {
      actionType: 'PUSH',
      description: 'reject the push',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
  });

  it('rejects an invalid action type', async () => {
    const runId = await createRun();
    const response = await post(`/api/workflows/${runId}/approve`, {
      actionType: 'DELETE_EVERYTHING',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('returns 409 when resolving an unknown approval request', async () => {
    const runId = await createRun();
    const response = await post(`/api/workflows/${runId}/approve`, {
      requestId: 'does-not-exist',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('approval_failed');
  });
});

describe('API — security posture', () => {
  it('returns a structured error for an unknown route', async () => {
    const response = await get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('sends no CORS header by default', async () => {
    const response = await fetch(`${base}/health`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never returns credential-like fields', async () => {
    const runId = await createRun();
    const metrics = await get(`/api/runs/${runId}/metrics`);
    const serialized = JSON.stringify(metrics.body);

    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/bearer/i);
  });

  it('rejects a wildcard CORS configuration', () => {
    expect(() =>
      createApiApp({
        runs: composition.runService,
        workflows: composition.workflowService,
        approvals: composition.approvalService,
        evaluation: composition.evaluationService,
        llm: composition.llm,
        corsOrigins: ['*'],
      }),
    ).toThrow(/wildcard/);
  });

  it('allows an explicit CORS origin when configured', async () => {
    const app = createApiApp({
      runs: composition.runService,
      workflows: composition.workflowService,
      approvals: composition.approvalService,
      evaluation: composition.evaluationService,
      llm: composition.llm,
      corsOrigins: ['http://localhost:5173'],
    });

    const allowed = await app.request('/health', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const denied = await app.request('/health', {
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});