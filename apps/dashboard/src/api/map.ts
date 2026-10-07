/**
 * Data mapping (M5-B).
 *
 * Maps raw API payloads into the view models the components
 * render. Kept pure and separate so the mapping rules — in
 * particular how evidence payloads and events become timeline
 * entries — are unit testable without a DOM or a server.
 *
 * This layer reshapes only. It never recomputes a score, never
 * decides an approval outcome, and never infers backend state.
 */

import type {
  EvidenceRecord,
  ListEvidenceResponse,
  ListEventsResponse,
  PendingApproval,
  RunEvent,
  RunMetrics,
  RunSummary,
  RunTask,
} from './types';
import { UNAVAILABLE } from './format';

/**
 * The subset of a resource's state that a panel needs.
 *
 * Declaring it here (rather than importing the hook into every
 * panel) keeps the components decoupled from the hook module and
 * keeps this file free of React imports.
 */
export type PanelResourceState<T> = {
  readonly status: 'loading' | 'success' | 'error' | 'idle';
  readonly data: T | null;
  readonly error?: string;
};

/** One row in the run timeline. */
export interface TimelineEntry {
  readonly seq: number;
  readonly timestamp: string;
  /** Agent that emitted the event, when known. */
  readonly agent: string | null;
  readonly task: string | null;
  /** Human-readable operation label. */
  readonly operation: string;
  readonly status: 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
  readonly type: string;
  /** Extra detail lines (tool name, refusal reason, ...). */
  readonly details: readonly string[];
}

/** One row in the evidence table. */
export interface EvidenceView {
  readonly id: string;
  readonly kind: string;
  readonly timestamp: string;
  readonly agent: string | null;
  readonly task: string | null;
  readonly tool: string | null;
  readonly source: string | null;
  readonly result: string;
  readonly hash: string;
}

/** One node in the agent pipeline. */
export interface PipelineStage {
  readonly label: string;
  readonly status: 'succeeded' | 'failed' | 'running' | 'pending' | 'skipped';
  readonly agent: string | null;
  readonly summary: string | null;
  readonly durationMs: number | null;
  readonly attempts: number | null;
}

/** A metric row for the metrics panel. */
export interface MetricRow {
  readonly label: string;
  readonly value: string;
  /** False when the API reported the value as unavailable. */
  readonly available: boolean;
}

function readString(data: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(data: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map an evidence payload to the fields the table displays. */
export function mapEvidence(record: EvidenceRecord): EvidenceView {
  const data = record.data;
  const result =
    data['ok'] === true
      ? 'ok'
      : data['ok'] === false
        ? readString(data, 'error') ?? 'failed'
        : readString(data, 'status') ?? readString(data, 'decision') ?? UNAVAILABLE;

  return {
    id: record.evidenceId,
    kind: record.kind,
    timestamp: record.createdAt,
    agent: readString(data, 'agent'),
    task: readString(data, 'taskId'),
    tool: readString(data, 'tool'),
    source: readString(data, 'source') ?? readString(data, 'provider'),
    result,
    hash: record.hash,
  };
}

/** Map a whole evidence response. */
export function mapEvidenceResponse(response: ListEvidenceResponse): EvidenceView[] {
  return response.evidence.map(mapEvidence);
}

/** Map an event to a timeline row. */
export function mapEvent(event: RunEvent): TimelineEntry {
  const payload = event.payload;
  const data = isRecord(payload['data']) ? payload['data'] : {};

  // Evidence carries the interesting detail; the envelope only has
  // its kind.
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : event.type;
  const operation =
    typeof payload['kind'] === 'string'
      ? labelFromKind(payload['kind'])
      : labelFromEventType(event.type);

  const agent = readString(data, 'agent');
  const details: string[] = [];

  const tool = readString(data, 'tool');
  if (tool !== null) details.push(`tool: ${tool}`);

  const refusal = readString(data, 'refusalReason');
  if (refusal !== null) details.push(`refusal: ${refusal}`);

  const decision = readString(data, 'policyDecision');
  if (decision !== null) details.push(`policy: ${decision}`);

  const error = readString(data, 'error') ?? readString(payload, 'error');
  if (error !== null) details.push(error);

  const tokens = readNumber(data, 'totalTokens');
  if (tokens !== null) details.push(`tokens: ${tokens}`);

  return {
    seq: event.seq,
    timestamp: event.occurredAt,
    agent,
    task: event.taskId ?? null,
    operation,
    status: toneForEvent(kind, event.type, data),
    type: event.type,
    details,
  };
}

/** Map a whole events response, oldest first. */
export function mapTimeline(response: ListEventsResponse): TimelineEntry[] {
  return [...response.events].sort((a, b) => a.seq - b.seq).map(mapEvent);
}

function labelFromKind(kind: string): string {
  const map: Record<string, string> = {
    'workflow.started': 'Workflow started',
    'workflow.outcome': 'Workflow completed',
    'plan.created': 'Plan created',
    'repair.started': 'Repair started',
    'repair.completed': 'Repair completed',
    'agent.start': 'Agent started',
    'agent.end': 'Agent finished',
    'model.call': 'Model call',
    'structured.validation': 'Schema validation',
    'tool.call': 'Tool call',
    'tool.result': 'Tool result',
    'tool.policy': 'Policy decision',
    'verification': 'Verification',
    'plan.warnings': 'Plan warnings',
    'knowledge.retrieval': 'Knowledge retrieval',
    'skill.selected': 'Skill selected',
  };
  return map[kind] ?? humanize(kind);
}

function labelFromEventType(type: string): string {
  const map: Record<string, string> = {
    'run.created': 'Run created',
    'run.completed': 'Run completed',
    'run.failed': 'Run failed',
    'run.cancelled': 'Run cancelled',
    'task.queued': 'Task queued',
    'task.started': 'Task started',
    'task.succeeded': 'Task succeeded',
    'task.failed': 'Task failed',
    'task.retried': 'Task retried',
    'task.cancelled': 'Task cancelled',
    'task.skipped': 'Task skipped',
  };
  return map[type] ?? humanize(type);
}

function humanize(value: string): string {
  return value.replace(/[._]/g, ' ');
}

function toneForEvent(
  kind: string,
  type: string,
  data: Readonly<Record<string, unknown>>,
): TimelineEntry['status'] {
  if (kind === 'tool.policy' && data['allowed'] === false) return 'bad';
  if (type === 'task.failed' || type === 'run.failed') return 'bad';
  if (type === 'task.retried' || type === 'task.queued' || type === 'task.skipped') return 'warn';
  if (type === 'task.cancelled' || type === 'run.cancelled') return 'info';
  // A tool result reports its own outcome, so surface success and
  // failure distinctly instead of rendering everything grey.
  if (kind === 'tool.result') return data['ok'] === false ? 'bad' : 'ok';
  if (kind === 'verification') return data['passed'] === true ? 'ok' : 'warn';
  if (kind === 'agent.end') return data['status'] === 'failed' ? 'bad' : 'ok';
  if (type === 'evidence.recorded') return 'neutral';
  return 'info';
}

/**
 * Build the agent pipeline from real task rows.
 *
 * Stages are derived from the tasks the backend actually ran, so a
 * repair cycle appears as an extra Builder/Verifier pair rather
 * than being hard-coded.
 */
export function mapPipeline(tasks: readonly RunTask[]): PipelineStage[] {
  const order = ['planner', 'researcher', 'builder', 'verifier'];
  const stages: PipelineStage[] = [];

  for (const agent of order) {
    const matching = tasks.filter((task) => task.agent === agent);
    if (matching.length === 0) continue;
    // When an agent ran more than once (a repair cycle), the last
    // attempt is the one that counts for the final state.
    const latest = matching[matching.length - 1]!;
    stages.push({
      label: capitalize(agent),
      status: normalizeStatus(latest.status),
      agent,
      summary: latest.task_name,
      durationMs: null,
      attempts: latest.attempts,
    });
  }

  return stages;
}

function normalizeStatus(status: string): PipelineStage['status'] {
  const normalized = status.toLowerCase();
  if (normalized === 'succeeded') return 'succeeded';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'running' || normalized === 'ready') return 'running';
  if (normalized === 'skipped') return 'skipped';
  return 'pending';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Build the metrics rows, preserving "unavailable" as N/A. */
export function mapMetricRows(metrics: RunMetrics): MetricRow[] {
  return [
    { label: 'Run duration', value: formatMetricValue(metrics.durationMs), available: metrics.durationMs !== null },
    { label: 'Agent duration (sum)', value: formatMetricValue(metrics.agentDurationMs), available: metrics.agentDurationMs !== null },
    { label: 'Tool calls', value: formatMetricValue(metrics.toolCallCount), available: metrics.toolCallCount !== null },
    { label: 'Retries', value: formatMetricValue(metrics.retryCount), available: metrics.retryCount !== null },
    { label: 'Errors', value: formatMetricValue(metrics.errorCount), available: metrics.errorCount !== null },
    { label: 'Policy denials', value: formatMetricValue(metrics.policyDenialCount), available: metrics.policyDenialCount !== null },
    { label: 'Repairs', value: formatMetricValue(metrics.repairCount), available: metrics.repairCount !== null },
    { label: 'Input tokens', value: formatMetricValue(metrics.inputTokens), available: metrics.inputTokens !== null },
    { label: 'Output tokens', value: formatMetricValue(metrics.outputTokens), available: metrics.outputTokens !== null },
    { label: 'Total tokens', value: formatMetricValue(metrics.totalTokens), available: metrics.totalTokens !== null },
  ];
}

function formatMetricValue(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return value.toLocaleString('en-US');
}

/** Map a pending approval to its display form. */
export function mapApproval(approval: PendingApproval): {
  readonly requestId: string;
  readonly action: string;
  readonly capability: string;
  readonly reason: string;
  readonly runId: string | null;
  readonly createdAt: string;
} {
  return {
    requestId: approval.requestId,
    // `actionType` is the capability being requested, e.g. COMMIT.
    action: approval.actionType,
    capability: approval.actionType,
    reason: approval.description,
    runId: approval.runId,
    createdAt: approval.createdAt,
  };
}

/** Filter runs to those matching a free-text query. */
export function filterRuns(
  runs: readonly RunSummary[],
  query: string,
): RunSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...runs];
  return runs.filter(
    (run) =>
      run.name.toLowerCase().includes(needle) ||
      run.id.toLowerCase().includes(needle) ||
      run.status.toLowerCase().includes(needle),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}