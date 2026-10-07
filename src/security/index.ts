/**
 * Security / prompt-injection defense (Milestone 4).
 *
 * Deterministic first-line defense against prompt injection.
 * Treats retrieved documents, repository files, tool output,
 * and external text as untrusted DATA.
 *
 * IMPORTANT: This is a deterministic defense layer, NOT a
 * complete security solution. It catches common patterns but
 * cannot guarantee protection against all attacks.
 */
export * from './injection-detector.js';
