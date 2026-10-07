/**
 * Run list (M5-B).
 *
 * A sortable, filterable table of runs. Duration, evaluation score
 * and approval state all come from `GET /api/runs`.
 */

import { useMemo, useState } from 'react';
import type { RunSummary } from '../api/types';
import { filterRuns } from '../api/map';
import { formatDuration, formatScore, formatTimestamp, shortId } from '../api/format';
import {
  ApprovalBadge,
  AsyncBoundary,
  Panel,
  StatusBadge,
  Table,
} from './ui';
import type { PanelResourceState } from '../api/map';

type SortKey = 'createdAt' | 'status' | 'durationMs' | 'evaluationScore';

export function RunList({
  state,
  onRefresh,
  isRefreshing,
  onOpenRun,
  selectedRunId,
}: {
  state: PanelResourceState<readonly RunSummary[]>;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenRun: (runId: string) => void;
  selectedRunId: string | null;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');

  const rows = useMemo(() => {
    if (state.data === null) return [];
    const filtered = filterRuns(state.data, query);

    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'durationMs':
          return (a.durationMs ?? -1) - (b.durationMs ?? -1);
        case 'evaluationScore':
          return (a.evaluationScore ?? -1) - (b.evaluationScore ?? -1);
        case 'status':
          return a.status.localeCompare(b.status);
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });
  }, [state.data, query, sortKey]);

  const header = (key: SortKey, label: string): JSX.Element => (
    <th
      className="table__sortable"
      onClick={() => setSortKey(key)}
      aria-sort={sortKey === key ? 'ascending' : 'none'}
    >
      {label}
      {sortKey === key && <span aria-hidden="true"> ▾</span>}
    </th>
  );

  return (
    <Panel
      title="Runs"
      subtitle={`${rows.length} run${rows.length === 1 ? '' : 's'}`}
      actions={
        <>
          <input
            className="input"
            type="search"
            placeholder="Filter by id, objective or status…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter runs"
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
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
        loadingLabel="Loading runs…"
        emptyLabel="No runs yet"
      >
        {() => (
          <Table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Objective</th>
                <th>Status</th>
                {header('createdAt', 'Created')}
                {header('durationMs', 'Duration')}
                {header('evaluationScore', 'Evaluation')}
                <th>Approval</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr
                  key={run.id}
                  className={run.id === selectedRunId ? 'table__row table__row--selected' : 'table__row'}
                  onClick={() => onOpenRun(run.id)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenRun(run.id);
                    }
                  }}
                >
                  <td className="mono" title={run.id}>
                    {shortId(run.id)}
                  </td>
                  <td className="table__name" title={run.name}>
                    {run.name.length > 48 ? `${run.name.slice(0, 45)}...` : run.name}
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="mono">{formatTimestamp(run.createdAt)}</td>
                  <td className="mono">{formatDuration(run.durationMs)}</td>
                  <td className="mono">{formatScore(run.evaluationScore)}</td>
                  <td>
                    <ApprovalBadge state={run.approvalState} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="table__empty">
                    No runs match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </AsyncBoundary>
    </Panel>
  );
}