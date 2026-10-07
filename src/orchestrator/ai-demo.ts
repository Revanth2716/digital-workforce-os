import type { JsonValue } from '../core/json.js';

/**
 * The canonical Milestone 2 demo scenario.
 *
 * The objective, the planned tasks and every scripted
 * model response are plain data, so the AI workflow demo
 * runs end-to-end with the deterministic provider: zero
 * network access, zero API keys, fully reproducible.
 *
 * The scenario deliberately exercises the repair cycle:
 * the builder's first attempt is incomplete, the verifier
 * rejects it with a structured failure report, the builder
 * repairs it, and the verifier passes on the second cycle.
 */
export const AI_DEMO_OBJECTIVE =
  'Add structured output validation to the workflow engine';

/**
 * Scripted structured responses for the deterministic LLM
 * provider, keyed by intent:
 *
 * - `plan`            — the planner's AgentPlan
 * - `research`        — the researcher's findings + tool request
 * - `build`           — the builder's first (defective) attempt
 * - `verify:0`        — the verifier rejects it (cycle 0)
 * - `build:repair`    — the builder's repaired attempt
 * - `verify:1`        — the verifier accepts it (cycle 1)
 */
export function createDemoResponses(): Record<string, JsonValue> {
  return {
    plan: {
      objective: AI_DEMO_OBJECTIVE,
      summary:
        'Research current output handling, implement Zod schemas for every agent artifact, then verify that invalid model output is rejected.',
      tasks: [
        {
          id: 'plan-task-research',
          name: 'research-validation-gaps',
          description:
            'Analyse how agent outputs are handled today and where validation is missing.',
          assignedAgent: 'researcher',
          tools: ['word_count'],
          dependsOn: [],
          expectedOutcome:
            'Structured findings identifying the missing validation layer',
        },
        {
          id: 'plan-task-build',
          name: 'implement-schemas',
          description:
            'Implement Zod schemas for agent plans, results, tool calls and verification verdicts.',
          assignedAgent: 'builder',
          tools: ['calculator'],
          dependsOn: ['plan-task-research'],
          expectedOutcome:
            'A validated schema module covering every structured artifact',
        },
        {
          id: 'plan-task-verify',
          name: 'verify-schemas',
          description:
            'Verify the schema module rejects invalid model output and accepts valid output.',
          assignedAgent: 'verifier',
          tools: [],
          dependsOn: ['plan-task-build'],
          expectedOutcome:
            'A passing VerificationResult with no error-level issues',
        },
      ],
    },

    research: {
      topic: 'structured output validation',
      summary:
        'Agent outputs currently flow through the engine unvalidated; a Zod schema layer closes the gap.',
      findings: [
        'Agent results are persisted as raw JSON without schema checks',
        'Tool call requests need input validation before execution',
        'Verification verdicts require a structured pass/fail contract',
      ],
      sources: ['src/agents/agent.ts', 'src/core/json.ts'],
      taskId: 'research-validation-gaps',
      toolCallRequests: [
        {
          id: 'research-call-1',
          tool: 'word_count',
          arguments: {
            text: 'Structured outputs make agent reasoning auditable and reproducible.',
          },
        },
      ],
    },

    build: {
      summary:
        'First pass implemented the schema module but optional-field defaults were dropped on parse.',
      artifacts: ['src/agents/schemas.ts (partial)'],
      toolCallRequests: [
        {
          id: 'build-call-1',
          tool: 'calculator',
          arguments: { operation: 'add', a: 2, b: 3 },
        },
      ],
    },

    'verify:0': {
      passed: false,
      summary:
        'Schema module incomplete: optional fields with defaults are dropped instead of defaulted, so valid model output can be rejected.',
      score: 42,
      issues: [
        {
          severity: 'error',
          message:
            'Optional fields with .default() must be populated by the parser, not dropped',
        },
      ],
      evidence: ['evidence:build-call-1'],
    },

    'build:repair': {
      summary:
        'Repaired: safeParse now applies defaults, every artifact validates, and invalid output is rejected with structured issues.',
      artifacts: ['src/agents/schemas.ts', 'tests/ai-structured.test.ts'],
      toolCallRequests: [
        {
          id: 'repair-call-1',
          tool: 'calculator',
          arguments: { operation: 'multiply', a: 6, b: 7 },
        },
      ],
    },

    'verify:1': {
      passed: true,
      summary:
        'All schemas validate correctly: valid output passes, invalid output is rejected with structured, actionable issues.',
      score: 98,
      issues: [],
      evidence: ['evidence:repair-call-1'],
    },
  };
}
