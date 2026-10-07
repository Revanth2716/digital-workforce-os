/**
 * Evaluation test cases (Milestone 4).
 *
 * Structured test cases for deterministic evaluation of agent
 * workflows. Each test case defines inputs, expected outputs,
 * and assertions to evaluate.
 *
 * Test cases are version-controlled fixtures stored as
 * structured TypeScript/JSON data.
 */

import type { JsonValue } from '../core/json.js';
import type { MetricResult } from './metrics.js';

/** The type of a test case. */
export type TestCaseType =
  | 'successful_workflow'
  | 'invalid_structured_output'
  | 'irrelevant_retrieval'
  | 'unauthorized_tool_request'
  | 'prompt_injection'
  | 'failed_verification'
  | 'persistent_failure'
  | 'approval_required';

/** Expected outcome of a test case. */
export interface ExpectedOutcome {
  /** Whether the workflow should succeed. */
  readonly shouldSucceed: boolean;
  /** Expected minimum overall score [0, 1]. */
  readonly minScore?: number;
  /** Expected metric names that must pass. */
  readonly requiredMetrics?: readonly string[];
  /** Expected metric names that must fail. */
  readonly expectedFailures?: readonly string[];
}

/** A single evaluation test case. */
export interface EvaluationTestCase {
  /** Unique test case identifier. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Test case type. */
  readonly type: TestCaseType;
  /** Test case description. */
  readonly description: string;
  /** The objective/input for the workflow. */
  readonly input: JsonValue;
  /** Expected outcome. */
  readonly expected: ExpectedOutcome;
  /** Optional tags for filtering. */
  readonly tags?: readonly string[];
}

/** A test case with its evaluation result. */
export interface TestCaseResult {
  readonly testCase: EvaluationTestCase;
  readonly passed: boolean;
  readonly score: number;
  readonly failures: readonly string[];
  readonly evidence: readonly string[];
  /** Per-metric results, so a score is traceable to its cause. */
  readonly metrics: readonly MetricResult[];
}
