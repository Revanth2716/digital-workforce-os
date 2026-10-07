/**
 * API response helpers (Milestone 5-A).
 *
 * Every response — success or failure — is JSON with a stable
 * shape. Errors carry a machine-readable code, a safe message and
 * optional validation details, so clients never have to parse
 * prose or stack traces.
 */

import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { ApiError } from '../schemas.js';

/** Send a validated JSON success response. */
export function ok<T>(c: Context, body: T, status: 200 | 201 = 200): Response {
  return c.json(body as Record<string, unknown>, status);
}

/** Send a structured JSON error response. */
export function fail(
  c: Context,
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): Response {
  const error: ApiError = {
    error: {
      code,
      message,
      ...(details !== undefined && details.length > 0 ? { details: [...details] } : {}),
    },
  };
  return c.json(error as unknown as Record<string, unknown>, status as 400);
}

/**
 * Validate an outbound payload before sending it.
 *
 * Response validation is best-effort: a mismatch is logged rather
 * than thrown, so a schema drift cannot turn a working endpoint
 * into a 500. In strict mode it is surfaced instead.
 */
export function respondValidated<T>(
  c: Context,
  schema: ZodType<T>,
  body: unknown,
  status: 200 | 201 = 200,
  strict: boolean = false,
): Response {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    if (strict) {
      return fail(
        c,
        500,
        'response_schema_mismatch',
        'Response did not match its declared schema',
        issues,
      );
    }
  }
  return c.json(body as Record<string, unknown>, status);
}