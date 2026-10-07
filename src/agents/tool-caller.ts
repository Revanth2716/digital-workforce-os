import type { Clock, RunId, TaskId } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutionError } from '../core/errors.js';
import type { ToolCallRequest, ToolCallResult } from './schemas.js';

/** What a tool call needs from its executing task. */
export interface ToolCallContext {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  /** Every call and result is recorded as evidence. */
  readonly evidence: EvidenceLog;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The structured tool-calling flow (Milestone 2):
 *
 *   Agent -> ToolCallRequest -> ToolRegistry
 *        -> input validation -> execute
 *        -> ToolCallResult -> evidence/event
 *
 * Tool failures (unknown tool, schema validation,
 * execution error, non-read-only tool) are returned
 * as `ok: false` ToolCallResults rather than thrown,
 * so agents can react to — and report — them. Every
 * call and every result is recorded in the
 * append-only evidence log.
 */
export class ToolCaller {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly options: {
      /**
       * When true, only tools explicitly marked
       * `readOnly` may be invoked. Used by the
       * researcher agent.
       */
      readonly readOnlyOnly?: boolean;
    } = {},
  ) {}

  /** Execute a single tool call, recording evidence. */
  async call(
    request: ToolCallRequest,
    context: ToolCallContext,
  ): Promise<ToolCallResult> {
    const startedAt = context.clock.now();
    context.evidence.record({
      runId: context.runId,
      taskId: context.taskId,
      kind: 'tool.call',
      data: {
        callId: request.id,
        tool: request.tool,
        arguments: request.arguments as unknown as JsonValue,
      },
    });

    let result: ToolCallResult;
    try {
      if (this.options.readOnlyOnly) {
        const tool = this.tools.get(request.tool);
        if (tool.readOnly !== true) {
          throw new ToolExecutionError(
            request.tool,
            new Error(
              `tool '${request.tool}' is not marked read-only and cannot be invoked by a read-only agent`,
            ),
          );
        }
      }
      // The registry validates the arguments against the
      // tool's declared input schema before executing.
      const output = await this.tools.execute(
        request.tool,
        request.arguments,
        {
          signal: context.signal,
          clock: context.clock,
        },
      );
      result = {
        id: request.id,
        tool: request.tool,
        ok: true,
        output,
        durationMs: context.clock.now() - startedAt,
      };
    } catch (error) {
      result = {
        id: request.id,
        tool: request.tool,
        ok: false,
        error: errorMessage(error),
        durationMs: context.clock.now() - startedAt,
      };
    }

    context.evidence.record({
      runId: context.runId,
      taskId: context.taskId,
      kind: 'tool.result',
      data: {
        callId: request.id,
        tool: request.tool,
        ok: result.ok,
        durationMs: result.durationMs ?? null,
        output: result.ok ? ((result.output ?? null) as JsonValue) : null,
        error: result.ok ? null : (result.error ?? null),
      },
    });

    return result;
  }

  /** Execute tool calls sequentially, honouring cancellation. */
  async callAll(
    requests: readonly ToolCallRequest[],
    context: ToolCallContext,
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];
    for (const request of requests) {
      context.signal?.throwIfAborted();
      results.push(await this.call(request, context));
    }
    return results;
  }
}
