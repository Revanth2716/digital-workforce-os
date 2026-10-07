/**
 * Local observability (Milestone 5-A).
 *
 * In-process tracing and metrics using OpenTelemetry-compatible
 * naming and structure, persisted through the existing SQLite
 * layer.
 *
 * There is no OTel SDK dependency, no exporter and no network
 * endpoint: everything runs locally and for free.
 */
export * from './spans.js';
export * from './tracer.js';
export * from './metrics.js';
export * from './instrumentation.js';