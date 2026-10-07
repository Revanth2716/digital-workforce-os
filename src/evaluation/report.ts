/**
 * Evaluation report (Milestone 4).
 *
 * Structured report containing evaluation results for a
 * suite of test cases. The report is deterministic and
 * explainable: every score can be traced back to specific
 * metrics and evidence.
 */

import type { TestCaseResult } from './test-case.js';

/** A single test case result within the report. */
export interface ReportEntry {
  readonly testCaseId: string;
  readonly testCaseName: string;
  readonly type: string;
  readonly passed: boolean;
  readonly score: number;
  readonly failures: readonly string[];
  readonly evidence: readonly string[];
}

/** Summary statistics for the evaluation report. */
export interface ReportSummary {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly averageScore: number;
  readonly overallPassed: boolean;
}

/** A complete evaluation report. */
export interface EvaluationReport {
  /** The evaluation run id. */
  readonly runId: string;
  /** When the evaluation was produced (ISO timestamp). */
  readonly timestamp: string;
  /** Individual test case results. */
  readonly entries: readonly ReportEntry[];
  /** Summary statistics. */
  readonly summary: ReportSummary;
}

/**
 * Build an evaluation report from test case results.
 */
export function buildReport(
  runId: string,
  results: readonly TestCaseResult[],
): EvaluationReport {
  const entries: ReportEntry[] = results.map((result) => ({
    testCaseId: result.testCase.id,
    testCaseName: result.testCase.name,
    type: result.testCase.type,
    passed: result.passed,
    score: result.score,
    failures: result.failures,
    evidence: result.evidence,
  }));

  const passedCases = results.filter((r) => r.passed).length;
  const failedCases = results.length - passedCases;
  const averageScore =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.score, 0) / results.length;

  return {
    runId,
    timestamp: new Date().toISOString(),
    entries,
    summary: {
      totalCases: results.length,
      passedCases,
      failedCases,
      averageScore,
      overallPassed: failedCases === 0,
    },
  };
}

/**
 * Format a report as a human-readable string.
 */
export function formatReport(report: EvaluationReport): string {
  const lines: string[] = [
    `Evaluation Report: ${report.runId}`,
    `Timestamp: ${report.timestamp}`,
    `Summary: ${report.summary.passedCases}/${report.summary.totalCases} passed, avg score: ${report.summary.averageScore.toFixed(3)}`,
    '',
  ];

  for (const entry of report.entries) {
    const mark = entry.passed ? 'PASS' : 'FAIL';
    lines.push(`  [${mark}] ${entry.testCaseId} (${entry.type}) — score: ${entry.score.toFixed(3)}`);
    if (entry.failures.length > 0) {
      for (const failure of entry.failures) {
        lines.push(`         ${failure}`);
      }
    }
  }

  return lines.join('\n');
}
