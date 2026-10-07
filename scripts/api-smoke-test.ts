/**
 * API smoke test (Milestone 5-A).
 *
 * Starts the real server on an ephemeral port and exercises every
 * documented endpoint end-to-end against the deterministic
 * provider — fully offline, with no credentials and no external
 * service.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposition } from '../src/index.js';
import { startApiServer } from '../src/api/server.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { createDemoResponses, AI_DEMO_OBJECTIVE } from '../src/orchestrator/ai-demo.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-api-smoke-'));
  const composition = createComposition({
    dbPath: join(dir, 'smoke.db'),
    concurrency: 1,
    llmResponses: createDemoResponses(),
    policy: new PolicyEngine(),
    skillsDir: 'skills',
  });

  // Port 0 asks the OS for a free port, so the smoke test can run
  // alongside a real server without colliding.
  const server = await startApiServer({
    runs: composition.runService,
    workflows: composition.workflowService,
    approvals: composition.approvalService,
    evaluation: composition.evaluationService,
    llm: composition.llm,
    host: '127.0.0.1',
    port: 0,
  });

  const base = server.url;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  console.log('Digital Workforce OS — API smoke test (M5-A)');
  console.log('='.repeat(52));
  console.log(`Server: ${base} (deterministic provider, offline)`);
  console.log('');

  try {
    // ---- 1. /health ----
    const health = await get('/health');
    check('GET /health returns 200', health.status === 200, `got ${health.status}`);
    check('health reports ok', health.body?.status === 'ok');
    check('health reports deterministic mode', health.body?.deterministic === true);

    // ---- 2. create workflow ----
    const created = await post('/api/workflows', { objective: AI_DEMO_OBJECTIVE });
    check('POST /api/workflows returns 201', created.status === 201, `got ${created.status}`);
    const runId = created.body?.runId;
    check('created run has an id', typeof runId === 'string' && runId.length > 0);
    check('workflow succeeded', created.body?.status === 'succeeded', created.body?.status);
    check('workflow used the bounded repair cycle', created.body?.repairs === 1, String(created.body?.repairs));

    if (typeof runId !== 'string') {
      throw new Error('cannot continue without a run id');
    }

    // ---- 3. fetch run ----
    const run = await get(`/api/runs/${runId}`);
    check('GET /api/runs/:id returns 200', run.status === 200, `got ${run.status}`);
    check('run status is succeeded', run.body?.run?.status === 'succeeded');
    check('run has tasks', Array.isArray(run.body?.tasks) && run.body.tasks.length > 0);

    // ---- 4. fetch events ----
    const events = await get(`/api/runs/${runId}/events`);
    check('GET /api/runs/:id/events returns 200', events.status === 200, `got ${events.status}`);
    check('events were recorded', events.body?.count > 0, String(events.body?.count));
    check(
      'events include task lifecycle',
      Array.isArray(events.body?.events) &&
        events.body.events.some((e) => e.type === 'task.succeeded'),
    );

    // ---- 5. fetch evidence ----
    const evidence = await get(`/api/runs/${runId}/evidence`);
    check('GET /api/runs/:id/evidence returns 200', evidence.status === 200, `got ${evidence.status}`);
    check('evidence was recorded', evidence.body?.count > 0, String(evidence.body?.count));
    check(
      'evidence is hash-addressed',
      Array.isArray(evidence.body?.evidence) &&
        evidence.body.evidence.every((e) => /^[a-f0-9]{64}$/.test(e.hash)),
    );

    // ---- 6. fetch evaluation ----
    const evaluation = await get(`/api/runs/${runId}/evaluation`);
    check('GET /api/runs/:id/evaluation returns 200', evaluation.status === 200, `got ${evaluation.status}`);
    check('evaluation has a score', typeof evaluation.body?.score === 'number');
    check('evaluation reports metrics', Array.isArray(evaluation.body?.metrics) && evaluation.body.metrics.length > 0);

    // ---- 7. fetch metrics ----
    const metrics = await get(`/api/runs/${runId}/metrics`);
    check('GET /api/runs/:id/metrics returns 200', metrics.status === 200, `got ${metrics.status}`);
    check('run duration was measured', typeof metrics.body?.durationMs === 'number');
    check('tool calls were counted', typeof metrics.body?.toolCallCount === 'number', String(metrics.body?.toolCallCount));
    check(
      'token usage is reported or explicitly unavailable',
      metrics.body?.totalTokens === null || typeof metrics.body?.totalTokens === 'number',
    );
    check('spans were recorded', Array.isArray(metrics.body?.spans) && metrics.body.spans.length > 0);

    // ---- 8. list runs ----
    const list = await get('/api/runs');
    check('GET /api/runs returns 200', list.status === 200, `got ${list.status}`);
    check('list includes the created run', Array.isArray(list.body?.runs) && list.body.runs.some((r) => r.id === runId));

    // ---- 9. approval ----
    const approve = await post(`/api/workflows/${runId}/approve`, {
      actionType: 'COMMIT',
      description: 'approve the smoke-test commit',
      comment: 'smoke test',
    });
    check('POST approve returns 200', approve.status === 200, `got ${approve.status}`);
    check('approval was APPROVED', approve.body?.status === 'APPROVED', approve.body?.status);

    const reject = await post(`/api/workflows/${runId}/reject`, {
      actionType: 'PUSH',
      description: 'reject the smoke-test push',
    });
    check('POST reject returns 200', reject.status === 200, `got ${reject.status}`);
    check('rejection was REJECTED', reject.body?.status === 'REJECTED', reject.body?.status);

    // ---- 10. structured errors ----
    const invalid = await post('/api/workflows', { objective: '' });
    check('invalid body returns 422', invalid.status === 422, `got ${invalid.status}`);
    check(
      'error body is structured',
      typeof invalid.body?.error?.code === 'string' && Array.isArray(invalid.body?.error?.details),
    );

    const missing = await get('/api/runs/does-not-exist');
    check('unknown run returns 404', missing.status === 404, `got ${missing.status}`);
    check('404 uses the structured error shape', missing.body?.error?.code === 'run_not_found');

    const badQuery = await get('/api/runs?limit=99999');
    check('out-of-range limit returns 400', badQuery.status === 400, `got ${badQuery.status}`);

    const noRoute = await get('/api/nope');
    check('unknown route returns 404', noRoute.status === 404, `got ${noRoute.status}`);

    // ---- 11. dashboard support endpoints (M5-B) ----
    const stats = await get('/api/stats');
    check('GET /api/stats returns 200', stats.status === 200, `got ${stats.status}`);
    check('stats report total runs', typeof stats.body?.totalRuns === 'number');
    check(
      'stats report successful and failed runs',
      typeof stats.body?.successfulRuns === 'number' &&
        typeof stats.body?.failedRuns === 'number',
    );
    check(
      'stats report an average duration',
      stats.body?.averageDurationMs === null || typeof stats.body?.averageDurationMs === 'number',
    );
    check('stats report pending approvals', typeof stats.body?.pendingApprovals === 'number');
    check(
      'stats flag token availability explicitly',
      typeof stats.body?.tokenUsageAvailable === 'boolean',
    );

    const approvals = await get('/api/approvals');
    check('GET /api/approvals returns 200', approvals.status === 200, `got ${approvals.status}`);
    check('approvals response is a list', Array.isArray(approvals.body?.approvals));

    const scopedApprovals = await get(`/api/approvals?runId=${runId}`);
    check(
      'approvals can be scoped to a run',
      scopedApprovals.status === 200 && Array.isArray(scopedApprovals.body?.approvals),
    );

    // The run list must carry what the run table renders.
    const runsList = await get('/api/runs');
    const listed = (runsList.body?.runs ?? []).find((r) => r.id === runId);
    check('run list includes the created run', listed !== undefined);
    check('run list carries durationMs', listed !== undefined && 'durationMs' in listed);
    check('run list carries an evaluation score', listed !== undefined && 'evaluationScore' in listed);
    check(
      'run list carries an approval state',
      listed !== undefined && typeof listed.approvalState === 'string',
    );

    // ---- 12. no secrets leaked ----
    const serialized = JSON.stringify(metrics.body);
    check(
      'metrics response contains no credential-like field',
      !/(api[_-]?key|secret|password|bearer|authorization)/i.test(serialized),
    );
  } finally {
    await server.close();
    composition.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('API smoke test FAILED');
    process.exit(1);
  }
  console.log('API smoke test passed.');
  process.exit(0);
}

main().catch((error) => {
  console.error('API smoke test crashed:', error);
  process.exit(1);
});