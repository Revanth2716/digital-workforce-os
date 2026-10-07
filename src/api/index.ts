/**
 * REST API (Milestone 5-A).
 *
 * Local-only HTTP API over the application service layer.
 * Handlers validate input with Zod, delegate to services, and
 * return structured JSON. No orchestration logic is duplicated
 * here, and no external service is required.
 */
export * from './server.js';
export * from './schemas.js';
// `routes/responses.js` is intentionally not re-exported: its `ok` /
// `fail` helpers would collide with the `Result` helpers in
// `core/result.js` at the composition root.