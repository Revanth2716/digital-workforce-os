/**
 * Evaluation metrics (Milestone 4).
 *
 * Deterministic, explainable metrics for evaluating agent
 * workflow quality. Each metric produces a score in [0, 1]
 * with a pass/fail threshold and human-readable explanation.
 *
 * All scoring is deterministic: the same inputs always
 * produce the same scores.
 */

/** A single metric result. */
export interface MetricResult {
  readonly name: string;
  /** Score in [0, 1]. */
  readonly score: number;
  /** Whether the metric passed (score >= threshold). */
  readonly passed: boolean;
  /** Human-readable explanation. */
  readonly explanation: string;
  /** Optional details for debugging. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Configuration for a metric. */
export interface MetricConfig {
  /** Minimum score to pass. Defaults to 0.5. */
  readonly threshold?: number;
  /** Weight in the overall score. Defaults to 1. */
  readonly weight?: number;
}

/**
 * Calculate a metric score from a count of passed/total items.
 * Returns a score in [0, 1].
 */
export function ratioMetric(
  name: string,
  passed: number,
  total: number,
  config: MetricConfig = {},
): MetricResult {
  const threshold = config.threshold ?? 0.5;
  const score = total === 0 ? 0 : passed / total;
  const passedThreshold = score >= threshold;

  return {
    name,
    score,
    passed: passedThreshold,
    explanation: `${passed}/${total} passed (score: ${score.toFixed(3)}, threshold: ${threshold})`,
    details: { passed, total, threshold },
  };
}

/**
 * Calculate a binary metric (0 or 1).
 */
export function binaryMetric(
  name: string,
  condition: boolean,
  config: MetricConfig = {},
  explanation?: string,
): MetricResult {
  const threshold = config.threshold ?? 1.0;
  const score = condition ? 1 : 0;
  const passedThreshold = score >= threshold;

  return {
    name,
    score,
    passed: passedThreshold,
    explanation: explanation ?? (condition ? 'condition met' : 'condition not met'),
    details: { condition, threshold },
  };
}

/**
 * Calculate a weighted aggregate score from multiple metrics.
 * Returns a score in [0, 1].
 */
export function aggregateScore(metrics: readonly MetricResult[]): number {
  if (metrics.length === 0) return 0;
  const total = metrics.reduce((sum, m) => sum + m.score, 0);
  return total / metrics.length;
}

/**
 * Determine overall pass/fail from multiple metrics.
 * All metrics must pass for the overall result to pass.
 */
export function overallPass(metrics: readonly MetricResult[]): boolean {
  return metrics.every((m) => m.passed);
}
