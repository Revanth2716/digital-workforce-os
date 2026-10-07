/**
 * Dashboard overview (M5-B).
 *
 * Aggregate figures rendered from `GET /api/stats`. Every number
 * comes from the API; only the loading and empty states are
 * hard-coded.
 */

import type { RunStats } from '../api/types';
import {
  AsyncBoundary,
  EmptyState,
  LoadingState,
  Panel,
  StatCard,
} from './ui';
import { UNAVAILABLE, formatDuration, formatNumber } from '../api/format';
import type { PanelResourceState } from '../api/map';

function formatTokens(value: number | null): string {
  return value === null ? UNAVAILABLE : formatNumber(value);
}

export function Overview({
  state,
  onRefresh,
  isRefreshing,
}: {
  state: PanelResourceState<RunStats>;
  onRefresh: () => void;
  isRefreshing: boolean;
}): JSX.Element {
  return (
    <Panel
      title="Overview"
      subtitle="Aggregate figures computed server-side from stored runs"
      actions={
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <AsyncBoundary status={state.status} data={state.data} {...(state.status === 'error' ? { error: state.error } : {})} onRetry={onRefresh}>
        {(stats) => {
          if (stats.totalRuns === 0) {
            return (
              <EmptyState
                label="No runs yet"
                hint="Create a workflow to populate the control plane."
              />
            );
          }

          const successRate =
            stats.totalRuns === 0 ? 0 : Math.round((stats.successfulRuns / stats.totalRuns) * 100);

          return (
            <div className="stat-grid">
              <StatCard label="Total runs" value={formatNumber(stats.totalRuns)} />
              <StatCard
                label="Successful"
                value={formatNumber(stats.successfulRuns)}
                hint={`${successRate}% of runs`}
                tone="ok"
              />
              <StatCard
                label="Failed"
                value={formatNumber(stats.failedRuns)}
                tone={stats.failedRuns > 0 ? 'bad' : 'neutral'}
              />
              <StatCard
                label="Pending approvals"
                value={formatNumber(stats.pendingApprovals)}
                tone={stats.pendingApprovals > 0 ? 'warn' : 'neutral'}
              />
              <StatCard
                label="Tool calls"
                value={
                  stats.totalToolCalls === null ? UNAVAILABLE : formatNumber(stats.totalToolCalls)
                }
                tone="info"
              />
              <StatCard
                label="Avg run duration"
                value={formatDuration(stats.averageDurationMs)}
              />
              <StatCard
                label="Errors"
                value={stats.totalErrors === null ? UNAVAILABLE : formatNumber(stats.totalErrors)}
                tone={stats.totalErrors !== null && stats.totalErrors > 0 ? 'bad' : 'neutral'}
              />
              <StatCard
                label="Total tokens"
                // Explicitly unavailable when no provider reported
                // usage, rather than showing 0.
                value={
                  stats.tokenUsageAvailable
                    ? formatTokens(stats.totalTokens)
                    : UNAVAILABLE
                }
                hint={
                  stats.tokenUsageAvailable
                    ? `in ${formatTokens(stats.inputTokens)} / out ${formatTokens(stats.outputTokens)}`
                    : 'provider reported no usage'
                }
              />
            </div>
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

/** Loading placeholder used before the first stats response. */
export function OverviewSkeleton(): JSX.Element {
  return <LoadingState label="Loading overview…" />;
}