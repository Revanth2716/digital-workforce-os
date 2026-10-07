-- Milestone 5-A: local observability.
--
-- Spans are append-only (like events) so a run's trace can be
-- replayed. Aggregated metrics are keyed by (run_id, name) and
-- upserted, so repeated observations accumulate rather than
-- overwrite.
--
-- Token columns are nullable on purpose: when a provider does not
-- report usage the value stays NULL and is surfaced as
-- "unavailable" rather than invented as zero.

CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT,
  task_id TEXT,
  task_name TEXT,
  model TEXT,
  provider TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  attributes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_run_id ON spans(run_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_spans_name ON spans(name);

CREATE TABLE IF NOT EXISTS run_metrics (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, name)
);
CREATE INDEX IF NOT EXISTS idx_run_metrics_run_id ON run_metrics(run_id);