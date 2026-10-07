/**
 * Dashboard application shell (M5-B).
 *
 * Owns the selected run and wires the panels to the API client.
 * All data comes from the local REST API; no business rule is
 * reimplemented here.
 */

import { useCallback, useMemo, useState } from 'react';
import { ApiClient, createApiClient } from './api/client';
import { formatScore } from './api/format';
import { useResource } from './hooks/useResource';
import { Overview } from './components/Overview';
import { RunList } from './components/RunList';
import {
  ApprovalPanel,
  Evaluation,
  Evidence,
  Metrics,
  Pipeline,
  Timeline,
} from './components/RunDetailPanels';
import { ErrorState, Field, Panel } from './components/ui';
import type { RunSummary } from './api/types';

/** Poll interval for the dashboard's refresh loops, in ms. */
const POLL_MS = 5000;

export function App(): JSX.Element {
  const [client] = useState<ApiClient>(() => createApiClient());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [newObjective, setNewObjective] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // ---- Health ----
  const health = useResource(() => client.health(), []);

  // ---- Overview + run list ----
  const stats = useResource(() => client.getStats(), [], { pollMs: POLL_MS });
  const runsResource = useResource(
    async () => (await client.listRuns()).runs,
    [],
    { pollMs: POLL_MS },
  );

  // ---- Selected run ----
  const selectedRun: RunSummary | null = useMemo(() => {
    if (selectedRunId === null || runsResource.state.data === null) return null;
    return runsResource.state.data.find((run) => run.id === selectedRunId) ?? null;
  }, [selectedRunId, runsResource.state.data]);

  const runDetail = useResource(
    () => client.getRun(selectedRunId as string),
    [selectedRunId],
    { enabled: selectedRunId !== null },
  );
  const events = useResource(
    () => client.getEvents(selectedRunId as string),
    [selectedRunId],
    { enabled: selectedRunId !== null, pollMs: POLL_MS },
  );
  const evidence = useResource(
    async () => (await client.getEvidence(selectedRunId as string)).evidence,
    [selectedRunId],
    { enabled: selectedRunId !== null },
  );
  const evaluation = useResource(
    () => client.getEvaluation(selectedRunId as string),
    [selectedRunId],
    { enabled: selectedRunId !== null, pollMs: POLL_MS },
  );
  const metrics = useResource(
    () => client.getMetrics(selectedRunId as string),
    [selectedRunId],
    { enabled: selectedRunId !== null, pollMs: POLL_MS },
  );
  const approvals = useResource(
    async () => (await client.listApprovals(selectedRunId ?? undefined)).approvals,
    [selectedRunId],
    { enabled: selectedRunId !== null, pollMs: POLL_MS },
  );

  // ---- Actions ----

  const createWorkflow = useCallback(async () => {
    const objective = newObjective.trim();
    if (objective.length === 0) {
      setCreateError('Enter an objective first.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.createWorkflow(objective);
      setNewObjective('');
      setSelectedRunId(created.runId);
      stats.refresh();
      runsResource.refresh();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [client, newObjective, stats, runsResource]);

  const resolveApproval = useCallback(
    async (runId: string, action: 'approve' | 'reject', requestId?: string) => {
      setActionBusy(true);
      setActionError(null);
      try {
        if (action === 'approve') await client.approve(runId, requestId);
        else await client.reject(runId, requestId);

        // Re-read from the server so the UI reflects the backend's
        // decision rather than an optimistic guess.
        approvals.refresh();
        runsResource.refresh();
        stats.refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setActionBusy(false);
      }
    },
    [client, approvals, runsResource, stats],
  );

  const offline = health.state.data?.deterministic === true;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__logo" aria-hidden="true">
            DW
          </span>
          <div>
            <h1 className="app__title">Digital Workforce OS</h1>
            <p className="app__subtitle">
              Control plane{' '}
              {health.state.data !== null && (
                <>
                  · v{health.state.data.version}
                  {offline && <span className="chip chip--ok">offline / deterministic</span>}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="app__status">
          {health.state.status === 'success' && health.state.data !== null ? (
            <span className="chip chip--ok">API online</span>
          ) : health.state.status === 'error' ? (
            <span className="chip chip--bad">API unreachable</span>
          ) : (
            <span className="chip">connecting…</span>
          )}
        </div>
      </header>

      <main className="app__main">
        <Overview
          state={stats.state}
          onRefresh={stats.refresh}
          isRefreshing={stats.isRefreshing}
        />

        <Panel title="New workflow" subtitle="Runs the deterministic pipeline offline">
          <div className="composer">
            <input
              className="input input--grow"
              type="text"
              placeholder="Describe the objective, e.g. Add structured output validation…"
              value={newObjective}
              onChange={(event) => setNewObjective(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createWorkflow();
              }}
              aria-label="Workflow objective"
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void createWorkflow()}
              disabled={creating}
            >
              {creating ? 'Running…' : 'Run workflow'}
            </button>
          </div>
          {createError !== null && (
            <div className="state state--error" role="alert">
              <span className="state__label">{createError}</span>
            </div>
          )}
        </Panel>

        <RunList
          state={runsResource.state}
          onRefresh={runsResource.refresh}
          isRefreshing={runsResource.isRefreshing}
          onOpenRun={setSelectedRunId}
          selectedRunId={selectedRunId}
        />

        {selectedRunId === null ? (
          <Panel title="Run detail">
            <p className="muted">Select a run above to inspect its pipeline, timeline and evidence.</p>
          </Panel>
        ) : (
          <div className="detail">
            <Panel
              title="Run detail"
              subtitle={selectedRun?.id}
              actions={
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setSelectedRunId(null)}
                >
                  Close
                </button>
              }
            >
              {runDetail.state.status === 'error' ? (
                <ErrorState
                  message={runDetail.state.error}
                  onRetry={runDetail.refresh}
                />
              ) : runDetail.state.data === null ? (
                <p className="muted">Loading run…</p>
              ) : (
                <div className="fields">
                  <Field label="Objective">{runDetail.state.data.run.name}</Field>
                  <Field label="Status">{runDetail.state.data.run.status}</Field>
                  <Field label="Created">
                    <span className="mono">
                      {new Date(runDetail.state.data.run.createdAt).toISOString().slice(0, 19).replace('T', ' ')}
                    </span>
                  </Field>
                  <Field label="Duration">
                    {runDetail.state.data.durationMs === null ? (
                      <span className="muted">N/A</span>
                    ) : (
                      `${runDetail.state.data.durationMs} ms`
                    )}
                  </Field>
                  <Field label="Events">{runDetail.state.data.counters.events}</Field>
                  <Field label="Evidence">{runDetail.state.data.counters.evidence}</Field>
                </div>
              )}
            </Panel>

            <Pipeline
              tasks={runDetail.state.data?.tasks ?? []}
              evaluationPassed={evaluation.state.data?.passed}
            />

            <Evaluation
              state={evaluation.state}
              onRefresh={evaluation.refresh}
              isRefreshing={evaluation.isRefreshing}
            />

            <Metrics
              state={metrics.state}
              onRefresh={metrics.refresh}
              isRefreshing={metrics.isRefreshing}
            />

            <Timeline
              state={events.state}
              onRefresh={events.refresh}
              isRefreshing={events.isRefreshing}
            />

            <Evidence
              state={evidence.state}
              onRefresh={evidence.refresh}
              isRefreshing={evidence.isRefreshing}
            />

            <ApprovalPanel
              run={selectedRun}
              approvals={approvals.state.data ?? []}
              busy={actionBusy}
              actionError={actionError}
              onApprove={(runId, requestId) => void resolveApproval(runId, 'approve', requestId)}
              onReject={(runId, requestId) => void resolveApproval(runId, 'reject', requestId)}
            />
          </div>
        )}
      </main>

      <footer className="app__footer">
        <span>
          Local single-user development tool. No authentication layer, no external analytics, no
          cloud services — all data comes from the local API.
        </span>
        {selectedRun !== null && (
          <span className="muted">
            Selected run evaluation: {formatScore(selectedRun.evaluationScore)}
          </span>
        )}
      </footer>
    </div>
  );
}

/**
 * Local alias so the panel props accept the hook's resource state
 * without importing the hook into every component.
 */