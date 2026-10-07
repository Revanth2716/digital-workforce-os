/**
 * Demo-only sensitive tool (Milestone 4).
 *
 * A stand-in for `git commit` used by the safety demo to
 * exercise the REQUIRE_APPROVAL path end-to-end. It performs
 * no real git operation and has no side effects — it exists
 * so the approval flow can be demonstrated deterministically
 * and offline.
 */

import type { Tool, ToolContext } from '../tools/tool.js';
import type { JsonValue } from '../core/json.js';

export const demoCommitSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

/** Demo stand-in for `git commit`; requires COMMIT approval. */
export class DemoCommitTool implements Tool {
  readonly name = 'git.commit';
  readonly description = 'Demo commit tool: records an approved commit without side effects';
  readonly inputSchema = demoCommitSchema;
  readonly readOnly = false;

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const { message } = args as { message: string };
    return { committed: true, message } as JsonValue;
  }
}