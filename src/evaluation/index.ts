/**
 * Evaluation engine (Milestone 4).
 *
 * Deterministic evaluation of agent workflows. Provides:
 * - Metric calculation and scoring
 * - Test case definitions and execution
 * - Report generation with evidence references
 * - Reusable assertion functions
 *
 * All scoring is deterministic and explainable.
 */
export * from './metrics.js';
export * from './assertions.js';
export * from './test-case.js';
export * from './evaluator.js';
export * from './report.js';
