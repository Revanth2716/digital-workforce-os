/**
 * Formatter and mapping tests (M5-B).
 *
 * The single most important invariant asserted here: a value the
 * API reported as unavailable renders as "N/A" and is never
 * presented as 0.
 */

import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE,
  formatDuration,
  formatField,
  formatNumber,
  formatScore,
  formatTimestamp,
  labelForStatus,
  shortId,
  toneForStatus,
} from './format';
import {
  filterRuns,
  mapApproval,
  mapEvidence,
  mapEvidenceResponse,
  mapMetricRows,
  mapPipeline,
  mapTimeline,
} from './map';
import type { RunMetrics, RunSummary } from './types';

// ---- Formatters -------------------------------------------------------------

describe('formatters — unavailable values', () => {
  it('renders null as N/A, never 0', () => {
    expect(formatNumber(null)).toBe(UNAVAILABLE);
    expect(formatScore(null)).toBe(UNAVAILABLE);
    expect(formatDuration(null)).toBe(UNAVAILABLE);
  });

  it('renders undefined as N/A', () => {
    expect(formatNumber(undefined)).toBe(UNAVAILABLE);
    expect(formatDuration(undefined)).toBe(UNAVAILABLE);
  });

  it('renders non-finite values as N/A', () => {
    expect(formatNumber(Number.NaN)).toBe(UNAVAILABLE);
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe(UNAVAILABLE);
    expect(formatDuration(Number.NaN)).toBe(UNAVAILABLE);
  });

  it('renders a real zero as 0, not N/A', () => {
    // The distinction that matters: 0 is a measurement.
    expect(formatNumber(0)).toBe('0');
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatScore(0)).toBe('0%');
  });
});

describe('formatters — durations', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(999)).toBe('999 ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1000)).toBe('1.00 s');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(45000)).toBe('45.0 s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats hours', () => {
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(5400000)).toBe('1h 30m');
  });

  it('treats a negative duration as unavailable', () => {
    expect(formatDuration(-1)).toBe(UNAVAILABLE);
  });
});

describe('formatters — scores and timestamps', () => {
  it('formats scores as percentages', () => {
    expect(formatScore(1)).toBe('100%');
    expect(formatScore(0.42)).toBe('42%');
    expect(formatScore(0)).toBe('0%');
  });

  it('formats ISO timestamps', () => {
    expect(formatTimestamp('2026-01-15T10:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns a dash for missing or invalid timestamps', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('')).toBe('—');
    // Never renders "Invalid Date".
    expect(formatTimestamp('not-a-date')).toBe('—');
  });

  it('shortens long ids', () => {
    expect(shortId('short')).toBe('short');
    expect(shortId('0123456789abcdef', 6)).toBe('012345…');
  });
});

describe('formatters — status tones', () => {
  it('maps known statuses to tones', () => {
    expect(toneForStatus('succeeded')).toBe('ok');
    expect(toneForStatus('failed')).toBe('bad');
    expect(toneForStatus('PENDING_APPROVAL')).toBe('warn');
    expect(toneForStatus('running')).toBe('warn');
    expect(toneForStatus('APPROVED')).toBe('ok');
    expect(toneForStatus('REJECTED')).toBe('bad');
  });

  it('maps an unknown status to neutral rather than throwing', () => {
    expect(toneForStatus('brand_new_status')).toBe('neutral');
  });

  it('humanises status labels', () => {
    expect(labelForStatus('PENDING_APPROVAL')).toBe('Pending Approval');
    expect(labelForStatus('succeeded')).toBe('Succeeded');
  });

  it('renders arbitrary fields safely', () => {
    expect(formatField('text')).toBe('text');
    expect(formatField(42)).toBe('42');
    expect(formatField(true)).toBe('true');
    expect(formatField(null)).toBe(UNAVAILABLE);
    expect(formatField({ a: 1 })).toBe('{"a":1}');
  });
});

// ---- Evidence mapping -------------------------------------------------------

describe('mapping — evidence', () => {
  const record = {
    evidenceId: 'ev-1',
    kind: 'tool.result',
    createdAt: '2026-01-15T10:00:00.000Z',
    data: { tool: 'calculator', ok: true, agent: 'researcher', taskId: 'task-1' },
    hash: 'a'.repeat(64),
  };

  it('maps the fields the table renders', () => {
    const view = mapEvidence(record);
    expect(view.kind).toBe('tool.result');
    expect(view.tool).toBe('calculator');
    expect(view.agent).toBe('researcher');
    expect(view.task).toBe('task-1');
    expect(view.result).toBe('ok');
    expect(view.hash).toHaveLength(64);
  });

  it('surfaces the error for a failed tool result', () => {
    const view = mapEvidence({
      ...record,
      data: { tool: 'x', ok: false, error: 'policy denied' },
    });
    expect(view.result).toBe('policy denied');
  });

  it('renders missing fields as N/A rather than inventing values', () => {
    const view = mapEvidence({
      ...record,
      data: { tool: 'x', ok: true },
    });
    expect(view.agent).toBeNull();
    expect(view.task).toBeNull();
  });

  it('maps a whole response', () => {
    const views = mapEvidenceResponse({ runId: 'r', evidence: [record], count: 1 });
    expect(views).toHaveLength(1);
  });
});

// ---- Timeline mapping -------------------------------------------------------

describe('mapping — timeline', () => {
  it('maps an evidence event into a timeline entry', () => {
    const entries = mapTimeline({
      runId: 'r',
      count: 1,
      truncated: false,
      events: [
        {
          seq: 1,
          eventId: 'e1',
          type: 'evidence.recorded',
          taskId: 'task-1',
          occurredAt: '2026-01-15T10:00:00.000Z',
          payload: {
            kind: 'tool.result',
            data: { tool: 'calculator', ok: true, totalTokens: 12 },
          },
        },
      ],
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.operation).toBe('Tool result');
    expect(entry.task).toBe('task-1');
    expect(entry.status).toBe('ok');
    expect(entry.details).toContain('tool: calculator');
    expect(entry.details).toContain('tokens: 12');
  });

  it('flags a policy denial', () => {
    const entries = mapTimeline({
      runId: 'r',
      count: 1,
      truncated: false,
      events: [
        {
          seq: 1,
          eventId: 'e1',
          type: 'evidence.recorded',
          occurredAt: '2026-01-15T10:00:00.000Z',
          payload: {
            kind: 'tool.policy',
            data: { tool: 'git.commit', policyDecision: 'DENY', allowed: false, refusalReason: 'approval_denied' },
          },
        },
      ],
    });

    expect(entries[0]?.status).toBe('bad');
    expect(entries[0]?.details).toContain('refusal: approval_denied');
    expect(entries[0]?.details).toContain('policy: DENY');
  });

  it('marks a failed verification as a warning', () => {
    const entries = mapTimeline({
      runId: 'r',
      count: 1,
      truncated: false,
      events: [
        {
          seq: 1,
          eventId: 'e1',
          type: 'evidence.recorded',
          occurredAt: '2026-01-15T10:00:00.000Z',
          payload: { kind: 'verification', data: { passed: false } },
        },
      ],
    });

    expect(entries[0]?.status).toBe('warn');
  });

  it('orders entries oldest first', () => {
    const entries = mapTimeline({
      runId: 'r',
      count: 2,
      truncated: false,
      events: [
        { seq: 5, eventId: 'e2', type: 'task.succeeded', occurredAt: '2026-01-15T10:00:05.000Z', payload: {} },
        { seq: 2, eventId: 'e1', type: 'task.started', occurredAt: '2026-01-15T10:00:02.000Z', payload: {} },
      ],
    });

    expect(entries.map((e) => e.seq)).toEqual([2, 5]);
  });
});

// ---- Pipeline mapping -------------------------------------------------------

describe('mapping — pipeline', () => {
  it('derives stages from the tasks that actually ran', () => {
    const stages = mapPipeline([
      { id: '1', task_name: 'plan', agent: 'planner', status: 'succeeded', attempts: 1 },
      { id: '2', task_name: 'research', agent: 'researcher', status: 'succeeded', attempts: 1 },
      { id: '3', task_name: 'build', agent: 'builder', status: 'succeeded', attempts: 1 },
      { id: '4', task_name: 'verify', agent: 'verifier', status: 'succeeded', attempts: 1 },
    ]);

    expect(stages.map((s) => s.agent)).toEqual([
      'planner',
      'researcher',
      'builder',
      'verifier',
    ]);
    expect(stages.every((s) => s.status === 'succeeded')).toBe(true);
  });

  it('uses the latest attempt when an agent ran twice (repair)', () => {
    const stages = mapPipeline([
      { id: '3', task_name: 'build', agent: 'builder', status: 'failed', attempts: 1 },
      { id: '5', task_name: 'build (repair)', agent: 'builder', status: 'succeeded', attempts: 2 },
    ]);

    const builder = stages.find((s) => s.agent === 'builder');
    expect(builder?.status).toBe('succeeded');
    expect(builder?.attempts).toBe(2);
  });

  it('omits agents that never ran', () => {
    const stages = mapPipeline([
      { id: '1', task_name: 'plan', agent: 'planner', status: 'succeeded', attempts: 1 },
    ]);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.agent).toBe('planner');
  });

  it('returns an empty pipeline when nothing ran', () => {
    expect(mapPipeline([])).toEqual([]);
  });
});

// ---- Metrics mapping --------------------------------------------------------

describe('mapping — metrics', () => {
  const baseMetrics: RunMetrics = {
    runId: 'r',
    durationMs: 120,
    agentDurationMs: 80,
    toolCallCount: 3,
    errorCount: 0,
    retryCount: null,
    policyDenialCount: 1,
    repairCount: 1,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    tokenUsageAvailable: false,
    raw: [],
    spans: [],
  };

  it('renders available metrics as numbers', () => {
    const rows = mapMetricRows(baseMetrics);
    const duration = rows.find((r) => r.label === 'Run duration');
    expect(duration?.value).toBe('120');
    expect(duration?.available).toBe(true);
  });

  it('renders unavailable metrics as N/A, not 0', () => {
    const rows = mapMetricRows(baseMetrics);
    const retries = rows.find((r) => r.label === 'Retries');
    expect(retries?.value).toBe(UNAVAILABLE);
    expect(retries?.available).toBe(false);

    const tokens = rows.find((r) => r.label === 'Total tokens');
    expect(tokens?.value).toBe(UNAVAILABLE);
    expect(tokens?.available).toBe(false);
  });

  it('shows a measured zero as 0', () => {
    const rows = mapMetricRows({ ...baseMetrics, errorCount: 0 });
    const errors = rows.find((r) => r.label === 'Errors');
    expect(errors?.value).toBe('0');
    expect(errors?.available).toBe(true);
  });
});

// ---- Approval & filtering ---------------------------------------------------

describe('mapping — approvals', () => {
  it('maps a pending approval to its display form', () => {
    const view = mapApproval({
      requestId: 'req-1',
      actionType: 'COMMIT',
      description: 'commit the change',
      status: 'PENDING_APPROVAL',
      createdAt: '2026-01-15T10:00:00.000Z',
      runId: 'run-1',
    });

    expect(view.action).toBe('COMMIT');
    expect(view.capability).toBe('COMMIT');
    expect(view.reason).toBe('commit the change');
    expect(view.runId).toBe('run-1');
  });
});

describe('mapping — run filtering', () => {
  const runs: RunSummary[] = [
    {
      id: 'run-1',
      name: 'Add validation',
      status: 'succeeded',
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
      durationMs: 100,
      evaluationScore: 1,
      evaluationPassed: true,
      approvalState: 'NONE',
    },
    {
      id: 'run-2',
      name: 'Fix scheduler',
      status: 'failed',
      createdAt: '2026-01-15T11:00:00.000Z',
      updatedAt: '2026-01-15T11:00:00.000Z',
      durationMs: null,
      evaluationScore: null,
      evaluationPassed: false,
      approvalState: 'PENDING_APPROVAL',
    },
  ];

  it('returns everything for an empty query', () => {
    expect(filterRuns(runs, '   ')).toHaveLength(2);
  });

  it('matches on the objective', () => {
    const filtered = filterRuns(runs, 'scheduler');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('run-2');
  });

  it('matches on the run id', () => {
    expect(filterRuns(runs, 'run-1')).toHaveLength(1);
  });

  it('matches on status, case-insensitively', () => {
    expect(filterRuns(runs, 'FAILED')).toHaveLength(1);
  });

  it('returns nothing when there is no match', () => {
    expect(filterRuns(runs, 'zzzz')).toHaveLength(0);
  });
});