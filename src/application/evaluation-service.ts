/**
 * Evaluation service (Milestone 5-A).
 *
 * Recomputes a run's evaluation from persisted evidence by
 * building an `EvaluationContext` and delegating to the
 * Milestone 4 evaluator. No evaluation logic is duplicated here
 * — this module only projects stored data into the shape the
 * evaluator already consumes.
 */

import type { RunService, EvidenceRecordView } from './run-service.js';
import type { EvaluationContext, PolicyEvidence } from '../evaluation/evaluator.js';
import { evaluateRun } from '../evaluation/evaluator.js';
import type { TestCaseResult } from '../evaluation/test-case.js';
import { EVALUATION_SUITE } from '../evaluation/dataset.js';

/** Evaluation of a run, plus the case it was scored against. */
export interface RunEvaluationView {
  readonly runId: string;
  readonly testCaseId: string;
  readonly testCaseName: string;
  readonly passed: boolean;
  readonly score: number;
  readonly failures: readonly string[];
  readonly metrics: TestCaseResult['metrics'];
  readonly evidenceCount: number;
}

/** Options for evaluating a run. */
export interface EvaluationServiceOptions {
  readonly runService: RunService;
}

/**
 * Read-side evaluation over stored runs.
 */
export class EvaluationService {
  constructor(private readonly options: EvaluationServiceOptions) {}

  /**
   * Evaluate a run against a test case.
   *
   * Defaults to the canonical repair/re-evaluation case, which is
   * the shape a completed AI workflow run has.
   */
  evaluateRun(
    runId: string,
    testCaseId?: string,
  ): RunEvaluationView {
    const runService = this.options.runService;
    const testCase =
      EVALUATION_SUITE.find((tc) => tc.id === testCaseId) ??
      EVALUATION_SUITE.find((tc) => tc.type === 'failed_verification') ??
      EVALUATION_SUITE[0]!;

    const run = runService.findRun(runId);
    const evidence = runService.getEvidence(runId);
    const metrics = runService.getMetrics(runId);

    const succeeded = run?.status === 'succeeded';
    const repairs = metrics.repairCount ?? 0;
    const toolResults = evidence.filter((record) => record.kind === 'tool.result');

    const context: EvaluationContext = {
      runId,
      objective: run?.name ?? '',
      // The run row itself is the output envelope; its shape is a
      // valid JSON object by construction.
      output: {
        status: run?.status ?? 'unknown',
        name: run?.name ?? '',
      },
      succeeded,
      repairs,
      evidence: evidence.map((record) => record.evidenceId),
      ...(toolResults.length > 0
        ? {
            toolCalls: toolResults.map((record) => ({
              tool: String(record.data['tool'] ?? ''),
              ok: record.data['ok'] === true,
            })),
          }
        : {}),
      ...(metrics.raw.length > 0
        ? { policyDecisions: collectPolicyDecisions(evidence) }
        : {}),
      ...(succeeded ? { verification: { passed: true } } : {}),
    };

    const result = evaluateRun(context, testCase);

    return {
      runId,
      testCaseId: result.testCase.id,
      testCaseName: result.testCase.name,
      passed: result.passed,
      score: result.score,
      failures: result.failures,
      metrics: result.metrics,
      evidenceCount: evidence.length,
    };
  }
}

/**
 * Project `tool.policy` evidence into policy decisions.
 *
 * `allowed` is derived from the recorded refusal reason: a
 * decision with no refusal reason permitted the call.
 */
export function collectPolicyDecisions(
  evidence: readonly EvidenceRecordView[],
): PolicyEvidence[] {
  const decisions: PolicyEvidence[] = [];

  for (const record of evidence) {
    if (record.kind !== 'tool.policy') continue;
    const data = record.data;
    const decision = data['policyDecision'];
    const tool = data['tool'];
    if (
      typeof decision !== 'string' ||
      (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'REQUIRE_APPROVAL')
    ) {
      continue;
    }
    if (typeof tool !== 'string') continue;

    const refusalReason = data['refusalReason'];
    decisions.push({
      tool,
      policyDecision: decision,
      allowed: data['allowed'] === true && refusalReason === null,
      ...(typeof refusalReason === 'string' ? { refusalReason } : {}),
    });
  }

  return decisions;
}