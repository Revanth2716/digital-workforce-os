/**
 * Shared presentational components (M5-B).
 *
 * Small, dependency-free building blocks: status badges, stat
 * cards, tables, panels and the loading/empty/error states.
 *
 * No animation beyond CSS transitions, and no component here
 * fetches data — they receive it as props.
 */

import type { ReactNode } from 'react';
import { UNAVAILABLE, labelForStatus, toneForStatus } from '../api/format';
import type { Tone } from '../api/format';

// ---- Status badge -----------------------------------------------------------

export function StatusBadge({
  status,
  tone,
}: {
  status: string;
  tone?: Tone;
}): JSX.Element {
  const resolved = tone ?? toneForStatus(status);
  return (
    <span className={`badge badge--${resolved}`}>
      <span className="badge__dot" aria-hidden="true" />
      {labelForStatus(status)}
    </span>
  );
}

/** A badge for an approval state, which has its own vocabulary. */
export function ApprovalBadge({ state }: { state: string }): JSX.Element {
  const label =
    state === 'PENDING_APPROVAL'
      ? 'Pending approval'
      : state === 'NONE'
        ? 'No approval'
        : labelForStatus(state);

  return (
    <span className={`badge badge--${toneForStatus(state)}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

// ---- Stat card --------------------------------------------------------------

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  /** Already formatted; pass "N/A" for unavailable values. */
  value: string;
  hint?: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint !== undefined && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

// ---- Panel ------------------------------------------------------------------

export function Panel({
  title,
  actions,
  children,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <header className="panel__head">
        <div>
          <h2 className="panel__title">{title}</h2>
          {subtitle !== undefined && <p className="panel__subtitle">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="panel__actions">{actions}</div>}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

// ---- States -----------------------------------------------------------------

export function LoadingState({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  label = 'No data yet',
  hint,
}: {
  label?: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="state state--empty">
      <span className="state__label">{label}</span>
      {hint !== undefined && <span className="state__hint">{hint}</span>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="state state--error" role="alert">
      <span className="state__label">{message}</span>
      {onRetry !== undefined && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Render the right state for a resource, without repeating the
 * loading/empty/error branches at every call site.
 */
export function AsyncBoundary<T>({
  status,
  data,
  error,
  onRetry,
  isEmpty,
  loadingLabel,
  emptyLabel,
  children,
}: {
  status: 'loading' | 'success' | 'error' | 'idle';
  data: T | null;
  error?: string;
  onRetry?: () => void;
  isEmpty?: (data: T) => boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  children: (data: T) => ReactNode;
}): JSX.Element {
  // An error is shown even when stale data exists, so the panel
  // never silently presents outdated values as current.
  if (status === 'error' && error !== undefined) {
    return <ErrorState message={error} {...(onRetry !== undefined ? { onRetry } : {})} />;
  }
  if (status === 'idle') return <EmptyState label="Not selected" />;
  if (data === null) return <LoadingState {...(loadingLabel !== undefined ? { label: loadingLabel } : {})} />;
  if (status === 'loading') return <LoadingState {...(loadingLabel !== undefined ? { label: loadingLabel } : {})} />;
  if (isEmpty !== undefined && isEmpty(data)) {
    return <EmptyState {...(emptyLabel !== undefined ? { label: emptyLabel } : {})} />;
  }
  return <>{children(data)}</>;
}

// ---- Table helpers ----------------------------------------------------------

export function Table({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">{children}</table>
    </div>
  );
}

/** Render a value that may be unavailable, never coercing null to 0. */
export function Nullable({
  value,
  format,
}: {
  value: number | null | undefined;
  format: (input: number) => string;
}): JSX.Element {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="muted">{UNAVAILABLE}</span>;
  }
  return <span>{format(value)}</span>;
}

/** A labelled definition-list row, used in several panels. */
export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className="field__value">{children}</span>
    </div>
  );
}