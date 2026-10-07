/**
 * Run detail panels (M5-B).
 *
 * Pipeline, timeline, evidence, evaluation, metrics and approval
 * for one run. Each panel reads its own endpoint and renders only
 * what the API reported.
 */

import { useState } from 'react';
import type {
  EvidenceRecord,
  GetEvaluationResponse,
  ListEventsResponse,
  PendingApproval,
  RunMetrics,
  RunSummary,
} from '../api/types';
import { mapEvidence, mapMetricRows, mapPipeline, mapTimeline } from '../api/map';
import type { PanelResourceState } from '../api/map';
import { UNAVAILABLE, formatScore, formatTimestamp, shortId } from '../api/format';
import {
  AsyncBoundary,
  ApprovalBadge,
  Field,
  Panel,
  StatusBadge,
  Table,
} from './ui';

// ---- Pipeline ---------------------------------------------------------------

export function Pipeline({
  tasks,
  evaluationPassed,
}: {
  tasks: readonly { id: string; task_name: string; agent: string; status: string; attempts: number; error?: string | null }[];
  evaluationPassed: boolean | undefined;
}): JSX.Element {
  const stages = mapPipeline(tasks);

  return (
    <Panel title="Agent pipeline" subtitle="Derived from the tasks the engine actually ran">
      {stages.length === 0 ? (
        <p className="muted">No agent tasks recorded for this run.</p>
      ) : (
        <ol className="pipeline">
          {stages.map((stage) => (
            <li key={`${stage.agent}-${stage.attempts}`} className={`pipeline__stage pipeline__stage--${stage.status}`}>
              <span className="pipeline__marker" aria-hidden="true" />
              <div className="pipeline__body">
                <div className="pipeline__label">
                  {stage.label}
                  <StatusBadge status={stage.status} />
                </div>
                <div className="pipeline__meta">
                  <span className="muted">{stage.summary}</span>
                  {stage.attempts !== null && stage.attempts > 1 && (
                    <span className="muted"> · attempt {stage.attempts}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
          <li
            className={`pipeline__stage pipeline__stage--${
              evaluationPassed === true ? 'succeeded' : evaluationPassed === false ? 'failed' : 'pending'
            }`}
          >
            <span className="pipeline__marker" aria-hidden="true" />
            <div className="pipeline__body">
              <div className="pipeline__label">
                Evaluation
                <StatusBadge
                  status={
                    evaluationPassed === true
                      ? 'succeeded'
                      : evaluationPassed === false
                        ? 'failed'
                        : 'pending'
                  }
                />
              </div>
            </div>
          </li>
          {stages.some((stage) => stage.attempts !== null && stage.attempts > 1) && (
            <li className="pipeline__stage pipeline__stage--info">
              <span className="pipeline__marker" aria-hidden="true" />
              <div className="pipeline__body">
                <div className="pipeline__label">Repair</div>
                <div className="pipeline__meta muted">
                  A bounded repair cycle re-ran the affected stages.
                </div>
              </div>
            </li>
          )}
        </ol>
      )}
    </Panel>
  );
}

// ---- Timeline ---------------------------------------------------------------

export function Timeline({
  state,
  onRefresh,
  isRefreshing,
}: {
  state: PanelResourceState<ListEventsResponse>;
  onRefresh: () => void;
  isRefreshing: boolean;
}): JSX.Element {
  return (
    <Panel
      title="Event timeline"
      subtitle="Every typed event, newest panel shows oldest first"
      actions={
        <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <AsyncBoundary
        status={state.status}
        data={state.data}
        {...(state.status === 'error' ? { error: state.error } : {})}
        onRetry={onRefresh}
        loadingLabel="Loading events…"
      >
        {(events) => {
          const entries = mapTimeline(events);
          return (
            <div className="timeline">
              {entries.map((entry) => (
                <div key={`${entry.seq}-${entry.type}`} className="timeline__row">
                  <span className="timeline__time mono">{formatTimestamp(entry.timestamp)}</span>
                  <span className={`timeline__dot timeline__dot--${entry.status}`} aria-hidden="true" />
                  <div className="timeline__content">
                    <div className="timeline__operation">{entry.operation}</div>
                    <div className="timeline__meta">
                      {entry.agent !== null && <span className="chip">{entry.agent}</span>}
                      {entry.task !== null && <span className="chip chip--muted">{shortId(entry.task, 10)}</span>}
                      <span className={`chip chip--${entry.status}`}>{entry.type}</span>
                    </div>
                    {entry.details.length > 0 && (
                      <ul className="timeline__details">
                        {entry.details.map((detail, index) => (
                          <li key={index}>{detail}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
              {entries.length === 0 && <p className="muted">No events recorded.</p>}
            </div>
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

// ---- Evidence ---------------------------------------------------------------

export function Evidence({
  state,
  onRefresh,
  isRefreshing,
}: {
  state: PanelResourceState<readonly EvidenceRecord[]>;
  onRefresh: () => void;
  isRefreshing: boolean;
}): JSX.Element {
  const [kind, setKind] = useState('');

  return (
    <Panel
      title="Evidence"
      subtitle="Content-addressed audit records"
      actions={
        <>
          <select
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            aria-label="Filter evidence by kind"
          >
            <option value="">All kinds</option>
            {[...new Set((state.data ?? []).map((record) => record.kind))]
              .sort()
              .map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
          </select>
          <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </>
      }
    >
      <AsyncBoundary
        status={state.status}
        data={state.data}
        {...(state.status === 'error' ? { error: state.error } : {})}
        onRetry={onRefresh}
        loadingLabel="Loading evidence…"
        emptyLabel="No evidence recorded"
      >
        {(records) => {
          const filtered = kind === '' ? records : records.filter((r) => r.kind === kind);
          return (
            <Table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Timestamp</th>
                  <th>Agent</th>
                  <th>Tool</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => {
                  const view = mapEvidence(record);
                  return (
                    <tr key={view.id} className="table__row">
                      <td className="mono">{view.kind}</td>
                      <td className="mono">{formatTimestamp(view.timestamp)}</td>
                      <td>{view.agent ?? <span className="muted">{UNAVAILABLE}</span>}</td>
                      <td className="mono">{view.tool ?? <span className="muted">{UNAVAILABLE}</span>}</td>
                      <td className="mono">{view.source ?? <span className="muted">{UNAVAILABLE}</span>}</td>
                      <td>{view.result}</td>
                      <td className="mono" title={view.hash}>
                        {view.hash.length > 0 ? shortId(view.hash, 10) : UNAVAILABLE}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="table__empty">
                      No evidence matches this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

// ---- Evaluation -------------------------------------------------------------

export function Evaluation({
  state,
  onRefresh,
  isRefreshing,
}: {
  state: PanelResourceState<GetEvaluationResponse>;
  onRefresh: () => void;
  isRefreshing: boolean;
}): JSX.Element {
  return (
    <Panel
      title="Evaluation"
      subtitle="Deterministic scoring against the evaluation suite"
      actions={
        <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <AsyncBoundary
        status={state.status}
        data={state.data}
        {...(state.status === 'error' ? { error: state.error } : {})}
        onRetry={onRefresh}
        loadingLabel="Scoring run…"
      >
        {(evaluation) => (
          <div>
            <div className="score">
              <span className="score__value">{formatScore(evaluation.score)}</span>
              <StatusBadge status={evaluation.passed ? 'succeeded' : 'failed'} />
              <span className="score__case muted">{evaluation.testCaseName}</span>
            </div>

            {evaluation.failures.length > 0 && (
              <div className="failures">
                <h3 className="failures__title">Failures</h3>
                <ul>
                  {evaluation.failures.map((failure, index) => (
                    <li key={index}>{failure}</li>
                  ))}
                </ul>
              </div>
            )}

            <Table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Score</th>
                  <th>Result</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.metrics.map((metric) => (
                  <tr key={metric.name} className="table__row">
                    <td className="mono">{metric.name}</td>
                    <td className="mono">{formatScore(metric.score)}</td>
                    <td>
                      <StatusBadge status={metric.passed ? 'ok' : 'failed'} />
                    </td>
                    <td className="table__explanation">{metric.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </AsyncBoundary>
    </Panel>
  );
}

// ---- Metrics ----------------------------------------------------------------

export function Metrics({
  state,
  onRefresh,
  isRefreshing,
}: {
  state: PanelResourceState<RunMetrics>;
  onRefresh: () => void;
  isRefreshing: boolean;
}): JSX.Element {
  return (
    <Panel
      title="Metrics"
      subtitle="Local observability. Unavailable values are shown as N/A, never as 0."
      actions={
        <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <AsyncBoundary
        status={state.status}
        data={state.data}
        {...(state.status === 'error' ? { error: state.error } : {})}
        onRetry={onRefresh}
        loadingLabel="Loading metrics…"
      >
        {(metrics) => {
          const rows = mapMetricRows(metrics);
          return (
            <div>
              <div className="metric-grid">
                {rows.map((row) => (
                  <div key={row.label} className="metric">
                    <span className="metric__label">{row.label}</span>
                    <span className={row.available ? 'metric__value' : 'metric__value metric__value--na'}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
              {!metrics.tokenUsageAvailable && (
                <p className="muted metric__note">
                  The provider reported no token usage for this run.
                </p>
              )}
            </div>
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

// ---- Approval ---------------------------------------------------------------

export function ApprovalPanel({
  run,
  approvals,
  busy,
  actionError,
  onApprove,
  onReject,
}: {
  run: RunSummary | null;
  approvals: readonly PendingApproval[];
  busy: boolean;
  actionError: string | null;
  onApprove: (runId: string, requestId?: string) => void;
  onReject: (runId: string, requestId?: string) => void;
}): JSX.Element {
  if (run === null) {
    return (
      <Panel title="Policy & approval">
        <p className="muted">Select a run to review its approval state.</p>
      </Panel>
    );
  }

  const forRun = approvals.filter((approval) => approval.runId === run.id);

  return (
    <Panel
      title="Policy & approval"
      subtitle="Decisions are made by the backend approval service"
    >
      <Field label="Approval state">
        <ApprovalBadge state={run.approvalState} />
      </Field>

      {actionError !== null && (
        <div className="state state--error" role="alert">
          <span className="state__label">{actionError}</span>
        </div>
      )}

      {forRun.length === 0 ? (
        <p className="muted">No pending approval requests for this run.</p>
      ) : (
        <div className="approvals">
          {forRun.map((approval) => (
            <div key={approval.requestId} className="approval">
              <div className="approval__head">
                <span className="approval__action">{approval.actionType}</span>
                <span className="chip chip--warn">PENDING_APPROVAL</span>
              </div>
              <Field label="Capability">{approval.actionType}</Field>
              <Field label="Reason">{approval.description}</Field>
              <Field label="Requested">
                <span className="mono">{formatTimestamp(approval.createdAt)}</span>
              </Field>
              <div className="approval__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => onApprove(run.id, approval.requestId)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => onReject(run.id, approval.requestId)}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}