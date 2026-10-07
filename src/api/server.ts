/**
 * REST API server (Milestone 5-A).
 *
 * A local-only HTTP API built on Hono (MIT, dependency-free at
 * runtime) served through Node's built-in http server. Routes call
 * the application services; no business logic lives here.
 *
 * Security posture for local operation:
 * - binds to 127.0.0.1 by default (not 0.0.0.0),
 * - CORS is disabled by default; enabling it requires an explicit
 *   allowlist of origins, never a wildcard,
 * - no authentication is configured, because the server is local
 *   and single-user; the smoke test and demos never need one,
 * - no secrets are read, required or returned.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ApprovalService } from '../application/approval-service.js';
import type { EvaluationService } from '../application/evaluation-service.js';
import type { RunService } from '../application/run-service.js';
import type { WorkflowService } from '../application/workflow-service.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { StatusCode } from 'hono/utils/http-status';
import { DomainError } from '../core/errors.js';
import { registerRoutes } from './routes/routes.js';
import { fail } from './routes/responses.js';

/** Configuration for the API server. */
export interface ApiServerConfig {
  readonly runs: RunService;
  readonly workflows: WorkflowService;
  readonly approvals: ApprovalService;
  readonly evaluation: EvaluationService;
  readonly llm: LLMProvider;
  /** Defaults to 127.0.0.1 (loopback only). */
  readonly host?: string;
  /** Defaults to 4317. */
  readonly port?: number;
  readonly serviceName?: string;
  readonly version?: string;
  /**
   * Explicit CORS allowlist. Empty (the default) disables CORS
   * entirely. A wildcard is rejected.
   */
  readonly corsOrigins?: readonly string[];
  /** Validate outbound responses against their schemas. Defaults to false. */
  readonly strictResponses?: boolean;
}

/** A started server handle. */
export interface ApiServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Build the Hono app without starting it (useful for tests). */
export function createApiApp(config: ApiServerConfig): Hono {
  const app = new Hono();

  // ---- CORS: off unless an explicit allowlist is provided ----
  const origins = config.corsOrigins ?? [];
  if (origins.includes('*')) {
    throw new Error(
      'corsOrigins must not contain a wildcard; list explicit origins instead',
    );
  }
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origins.includes(origin)) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.res.headers.set('access-control-allow-headers', 'content-type');
      c.res.headers.set('vary', 'origin');
    }
    await next();
  });

  // ---- Unknown routes ----
  app.notFound((c) => fail(c, 404, 'not_found', 'Route not found'));

  // ---- Unexpected errors ----
  app.onError((error, c) => {
    if (error instanceof DomainError) {
      // Domain errors carry a stable code and a safe message.
      const status: StatusCode =
        error.code === 'validation' ? 400 : error.code === 'run_not_found' ? 404 : 409;
      return fail(c, status, error.code, error.message);
    }
    return fail(
      c,
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal error',
    );
  });

  registerRoutes(app, {
    runs: config.runs,
    workflows: config.workflows,
    approvals: config.approvals,
    evaluation: config.evaluation,
    llm: config.llm,
    serviceName: config.serviceName ?? 'digital-workforce-os',
    version: config.version ?? '0.5.0',
    startedAt: Date.now(),
    now: () => Date.now(),
  });

  return app;
}

/**
 * Start the API server.
 *
 * Binds to loopback by default so the API is not exposed to the
 * network. Pass `host` explicitly to change that.
 */
export function startApiServer(config: ApiServerConfig): Promise<ApiServerHandle> {
  const app = createApiApp(config);
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 4317;

  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: host,
        port,
        // Fail fast instead of hanging on a port conflict.
        overrideGlobalObjects: false,
      },
      (info) => {
        resolve({
          url: `http://${host}:${info.port}`,
          port: info.port,
          host,
          close: async () => {
            await new Promise<void>((done, failClose) => {
              server.close((error) => (error ? failClose(error) : done()));
            });
          },
        });
      },
    );

    server.on('error', reject);
  });
}