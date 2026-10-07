import type { EventId, RunId, TaskId } from '../core/types.js';
import type { JsonValue } from '../core/json.js';

/** Every event type emitted by the system. */
export type WorkflowEventType =
  | 'run.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'task.queued'
  | 'task.started'
  | 'task.succeeded'
  | 'task.failed'
  | 'task.retried'
  | 'task.cancelled'
  | 'task.skipped'
  | 'evidence.recorded';

/** Strongly typed payload per event type. */
export interface WorkflowEventPayloads {
  'run.created': { readonly runName: string; readonly taskCount: number };
  'run.completed': { readonly taskCount: number; readonly succeeded: number };
  'run.failed': { readonly taskCount: number; readonly succeeded: number; readonly failed: number };
  'run.cancelled': { readonly taskCount: number; readonly succeeded: number };
  'task.queued': { readonly taskName: string; readonly agent: string };
  'task.started': { readonly taskName: string; readonly agent: string; readonly attempt: number };
  'task.succeeded': {
    readonly taskName: string;
    readonly attempt: number;
    readonly durationMs: number;
    readonly summary: string;
  };
  'task.failed': {
    readonly taskName: string;
    readonly attempt: number;
    readonly durationMs: number;
    readonly error: string;
  };
  'task.retried': {
    readonly taskName: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
  };
  'task.cancelled': { readonly taskName: string; readonly reason: string };
  'task.skipped': { readonly taskName: string; readonly reason: string };
  'evidence.recorded': {
    readonly evidenceId: string;
    readonly kind: string;
    readonly data: JsonValue;
    readonly hash: string;
  };
}

/** Discriminated union of all workflow events. */
export type WorkflowEvent = {
  [K in WorkflowEventType]: {
    readonly id: EventId;
    readonly runId: RunId;
    readonly taskId?: TaskId;
    readonly type: K;
    readonly occurredAt: number;
    readonly payload: WorkflowEventPayloads[K];
  };
}[WorkflowEventType];

export type WorkflowEventOfType<K extends WorkflowEventType> = Extract<WorkflowEvent, { readonly type: K }>;

/** Type-safe event constructor. */
export function buildEvent<K extends WorkflowEventType>(
  type: K,
  base: { readonly id: EventId; readonly runId: RunId; readonly taskId?: TaskId; readonly occurredAt: number },
  payload: WorkflowEventPayloads[K],
): WorkflowEventOfType<K> {
  return { ...base, type, payload } as WorkflowEventOfType<K>;
}
