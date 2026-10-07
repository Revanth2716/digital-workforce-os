/**
 * Display formatters (M5-B).
 *
 * Pure functions, deliberately separated from components so they
 * can be unit tested without a DOM.
 *
 * The central rule: a value the backend reported as unavailable
 * (`null`) renders as "N/A". It is never coerced to `0`, which
 * would present "no data" as "measured zero".
 */

/** The label used for any value the API reported as unavailable. */
export const UNAVAILABLE = 'N/A';

/** Render a nullable number, or "N/A" when null/undefined. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return value.toLocaleString('en-US');
}

/**
 * Render a nullable duration in ms.
 *
 * Sub-second durations are shown in milliseconds; anything longer
 * uses the largest sensible unit so a 90-second run reads "1m 30s"
 * rather than "90,000 ms".
 */
export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  if (value < 0) return UNAVAILABLE;

  if (value < 1000) return `${Math.round(value)} ms`;

  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return remainderSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainderSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
}

/** Render a 0-1 score as a percentage. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return `${Math.round(value * 100)}%`;
}

/**
 * Render an ISO timestamp as a short local date-time.
 *
 * Returns "—" for an absent or unparseable value, so a bad
 * timestamp never renders as "Invalid Date".
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';

  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
  );
}

/** Shorten an identifier for dense table cells. */
export function shortId(id: string, keep = 8): string {
  if (id.length <= keep) return id;
  return `${id.slice(0, keep)}…`;
}

/**
 * Severity for a status string, used to pick a badge colour.
 *
 * Unknown statuses map to 'neutral' rather than throwing, so a new
 * backend status still renders.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export function toneForStatus(status: string): Tone {
  const normalized = status.toLowerCase();

  if (
    normalized === 'succeeded' ||
    normalized === 'ok' ||
    normalized === 'approved' ||
    normalized === 'completed'
  ) {
    return 'ok';
  }
  if (
    normalized === 'failed' ||
    normalized === 'rejected' ||
    normalized === 'cancelled' ||
    normalized === 'error'
  ) {
    return 'bad';
  }
  if (
    normalized === 'pending' ||
    normalized === 'pending_approval' ||
    normalized === 'running' ||
    normalized === 'queued' ||
    normalized === 'ready' ||
    normalized === 'warning'
  ) {
    return 'warn';
  }
  if (normalized === 'skipped' || normalized === 'suspicious') return 'info';
  return 'neutral';
}

/** Human label for a status string. */
export function labelForStatus(status: string): string {
  return status
    .split(/[._]/)
    .filter((part) => part.length > 0)
    // Lower-case the remainder so SCREAMING_SNAKE statuses read as
    // "Pending Approval" rather than "PENDING APPROVAL".
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/** Render an arbitrary evidence payload field as a short string. */
export function formatField(value: unknown): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
  } catch {
    return UNAVAILABLE;
  }
}