import { describe, expect, it } from 'vitest';
import { ratioMetric, binaryMetric, aggregateScore, overallPass } from '../src/evaluation/metrics.js';
import { assertDefined, assertNonEmpty, assertInRange, assertEquals, assertTrue } from '../src/evaluation/assertions.js';
import { evaluateRun, evaluateSuite } from '../src/evaluation/evaluator.js';
import type { EvaluationContext } from '../src/evaluation/evaluator.js';
import { EVALUATION_SUITE, getTestCase, getTestCasesByType } from '../src/evaluation/dataset.js';
import { buildReport, formatReport } from '../src/evaluation/report.js';
import type { EvaluationTestCase } from '../src/evaluation/test-case.js';

describe('Evaluation — metrics', () => {
  it('calculates ratio metrics correctly', () => {
    const metric = ratioMetric('test', 3, 4, { threshold: 0.7 });
    expect(metric.score).toBe(0.75);
    expect(metric.passed).toBe(true);
    expect(metric.name).toBe('test');
  });

  it('fails ratio metrics below threshold', () => {
    const metric = ratioMetric('test', 1, 4, { threshold: 0.5 });
    expect(metric.score).toBe(0.25);
    expect(metric.passed).toBe(false);
  });

  it('handles zero total in ratio metrics', () => {
    const metric = ratioMetric('test', 0, 0);
    expect(metric.score).toBe(0);
    expect(metric.passed).toBe(false);
  });

  it('calculates binary metrics correctly', () => {
    const passMetric = binaryMetric('test', true);
    expect(passMetric.score).toBe(1);
    expect(passMetric.passed).toBe(true);

    const failMetric = binaryMetric('test', false);
    expect(failMetric.score).toBe(0);
    expect(failMetric.passed).toBe(false);
  });

  it('calculates aggregate score', () => {
    const metrics = [
      { name: 'a', score: 0.8, passed: true, explanation: '' },
      { name: 'b', score: 0.6, passed: true, explanation: '' },
      { name: 'c', score: 1.0, passed: true, explanation: '' },
    ];
    expect(aggregateScore(metrics)).toBeCloseTo(0.8);
  });

  it('determines overall pass/fail', () => {
    const allPass = [
      { name: 'a', score: 1, passed: true, explanation: '' },
      { name: 'b', score: 1, passed: true, explanation: '' },
    ];
    expect(overallPass(allPass)).toBe(true);

    const oneFail = [
      { name: 'a', score: 1, passed: true, explanation: '' },
      { name: 'b', score: 0, passed: false, explanation: '' },
    ];
    expect(overallPass(oneFail)).toBe(false);
  });
});

describe('Evaluation — assertions', () => {
  it('asserts defined values', () => {
    expect(assertDefined('x', 'value').passed).toBe(true);
    expect(assertDefined('x', undefined).passed).toBe(false);
    expect(assertDefined('x', null).passed).toBe(false);
  });

  it('asserts non-empty strings', () => {
    expect(assertNonEmpty('x', 'hello').passed).toBe(true);
    expect(assertNonEmpty('x', '').passed).toBe(false);
  });

  it('asserts values in range', () => {
    expect(assertInRange('x', 5, 0, 10).passed).toBe(true);
    expect(assertInRange('x', 15, 0, 10).passed).toBe(false);
  });

  it('asserts equality', () => {
    expect(assertEquals('x', 5, 5).passed).toBe(true);
    expect(assertEquals('x', 5, 10).passed).toBe(false);
  });

  it('asserts true conditions', () => {
    expect(assertTrue('x', true).passed).toBe(true);
    expect(assertTrue('x', false).passed).toBe(false);
  });
});

describe('Evaluation — dataset', () => {
  it('contains all required test cases', () => {
    const ids = EVALUATION_SUITE.map((tc) => tc.id);
    expect(ids).toContain('tc-001-successful-research');
    expect(ids).toContain('tc-002-invalid-output');
    expect(ids).toContain('tc-003-irrelevant-retrieval');
    expect(ids).toContain('tc-004-unauthorized-tool');
    expect(ids).toContain('tc-005-prompt-injection');
    expect(ids).toContain('tc-006-failed-verification');
    expect(ids).toContain('tc-007-persistent-failure');
    expect(ids).toContain('tc-008-approval-required');
  });

  it('gets a test case by id', () => {
    const tc = getTestCase('tc-001-successful-research');
    expect(tc).toBeDefined();
    expect(tc!.name).toBe('Successful research workflow');
  });

  it('gets test cases by type', () => {
    const successCases = getTestCasesByType('successful_workflow');
    expect(successCases.length).toBeGreaterThan(0);
  });
});

describe('Evaluation — evaluator', () => {
  const baseContext: EvaluationContext = {
    runId: 'test-run',
    objective: 'test objective',
    output: { status: 'succeeded' },
    succeeded: true,
    repairs: 0,
    evidence: ['ev-1', 'ev-2'],
    toolCalls: [{ tool: 'word_count', ok: true }],
    verification: { passed: true, score: 90 },
  };

  it('evaluates a successful run', () => {
    const tc = getTestCase('tc-001-successful-research')!;
    const result = evaluateRun(baseContext, tc);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.failures).toHaveLength(0);
  });

  it('evaluates a failed run', () => {
    const tc = getTestCase('tc-002-invalid-output')!;
    const failContext: EvaluationContext = {
      ...baseContext,
      succeeded: false,
      output: null,
    };
    const result = evaluateRun(failContext, tc);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('evaluates repair behavior', () => {
    const tc = getTestCase('tc-006-failed-verification')!;
    const repairContext: EvaluationContext = {
      ...baseContext,
      repairs: 1,
    };
    const result = evaluateRun(repairContext, tc);
    expect(result.passed).toBe(true);
  });

  it('detects excessive repairs', () => {
    const tc = getTestCase('tc-007-persistent-failure')!;
    const failContext: EvaluationContext = {
      ...baseContext,
      succeeded: false,
      repairs: 2,
    };
    const result = evaluateRun(failContext, tc);
    expect(result.passed).toBe(false);
  });

  it('evaluates a suite and produces a report', () => {
    const tc = getTestCase('tc-001-successful-research')!;
    const result = evaluateRun(baseContext, tc);
    const report = evaluateSuite('test-suite', [result]);
    expect(report.summary.totalCases).toBe(1);
    expect(report.summary.passedCases).toBe(1);
    expect(report.summary.overallPassed).toBe(true);
  });
});

describe('Evaluation — report', () => {
  it('builds a report from results', () => {
    const tc = getTestCase('tc-001-successful-research')!;
    const result = evaluateRun(
      {
        runId: 'r1',
        objective: 'test',
        output: {},
        succeeded: true,
        repairs: 0,
        evidence: ['ev-1'],
      },
      tc,
    );
    const report = buildReport('r1', [result]);
    expect(report.runId).toBe('r1');
    expect(report.entries).toHaveLength(1);
    expect(report.summary.totalCases).toBe(1);
  });

  it('formats a report as a string', () => {
    const tc = getTestCase('tc-001-successful-research')!;
    const result = evaluateRun(
      {
        runId: 'r1',
        objective: 'test',
        output: {},
        succeeded: true,
        repairs: 0,
        evidence: ['ev-1'],
      },
      tc,
    );
    const report = buildReport('r1', [result]);
    const formatted = formatReport(report);
    expect(formatted).toContain('Evaluation Report');
    expect(formatted).toContain('tc-001-successful-research');
  });
});
