/**
 * API server entry point (Milestone 5-A).
 *
 * Starts the local REST API on a configurable host/port with
 * graceful shutdown on SIGINT/SIGTERM.
 *
 * Runs fully offline with the deterministic provider: no API key,
 * no external service, no network dependency. Pass
 * `API_HOST` / `API_PORT` to override the defaults.
 *
 * Usage:
 *   pnpm api              # http://127.0.0.1:4317
 *   API_PORT=5000 pnpm api
 */

import { createComposition } from '../index.js';
import { startApiServer } from './server.js';
import { RandomIdGenerator, SystemClock } from '../core/types.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { createDemoResponses, AI_DEMO_OBJECTIVE } from '../orchestrator/ai-demo.js';
import { join } from 'node:path';

async function main(): Promise<void> {
  const host = process.env['API_HOST'] ?? '127.0.0.1';
  const port = Number(process.env['API_PORT'] ?? 4317);
  const dbPath = process.env['API_DB'] ?? join('data', 'api.db');

  const composition = createComposition({
    dbPath,
    concurrency: 1,
    ids: new RandomIdGenerator(),
    clock: new SystemClock(),
    // Scripted responses keep API demos deterministic offline.
    llmResponses: createDemoResponses(),
    policy: new PolicyEngine(),
    skillsDir: 'skills',
  });

  const server = await startApiServer({
    runs: composition.runService,
    workflows: composition.workflowService,
    approvals: composition.approvalService,
    evaluation: composition.evaluationService,
    llm: composition.llm,
    host,
    port,
  });

  console.log('Digital Workforce OS — local REST API (M5-A)');
  console.log('='.repeat(52));
  console.log(`Listening   : ${server.url}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Provider    : ${composition.llm.name} (offline, deterministic)`);
  console.log('');
  console.log('Endpoints');
  console.log('  GET  /health');
  console.log('  GET  /api/runs');
  console.log('  GET  /api/runs/:id');
  console.log('  GET  /api/runs/:id/events');
  console.log('  GET  /api/runs/:id/evidence');
  console.log('  GET  /api/runs/:id/evaluation');
  console.log('  GET  /api/runs/:id/metrics');
  console.log('  POST /api/workflows');
  console.log('  POST /api/workflows/:id/approve');
  console.log('  POST /api/workflows/:id/reject');
  console.log('');
  console.log(`Try: curl -s -X POST ${server.url}/api/workflows \\`);
  console.log(`       -H 'content-type: application/json' \\`);
  console.log(`       -d '{"objective":"${AI_DEMO_OBJECTIVE}"}'`);
  console.log('');
  console.log('Press Ctrl+C to stop.');

  // ---- Graceful shutdown ----
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    try {
      await server.close();
      composition.close();
      console.log('Shutdown complete.');
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('API server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});