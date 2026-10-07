/** Lifecycle states of a task within a run. */
export const TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Lifecycle states of a run. */
export const RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Task statuses from which no further transition occurs. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}
