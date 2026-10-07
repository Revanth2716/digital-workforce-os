import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentPlanSchema,
  AgentResultSchema,
  PlannedTaskSchema,
  ResearchOutputSchema,
  ResearchResultSchema,
  ToolCallRequestSchema,
  ToolCallResultSchema,
  VerificationResultSchema,
  validateStructured,
} from '../src/agents/schemas.js';
import { DeterministicLLMProvider } from '../src/providers/deterministic-llm-provider.js';
import { StructuredOutputError } from '../src/core/errors.js';

/** Every structured schema the AI layer validates. */
const STRUCTURED_SCHEMAS: ReadonlyArray<{
  readonly name: string;
  readonly schema: z.ZodType;
}> = [
  { name: 'AgentPlan', schema: AgentPlanSchema },
  { name: 'PlannedTask', schema: PlannedTaskSchema },
  { name: 'AgentResult', schema: AgentResultSchema },
  { name: 'ToolCallRequest', schema: ToolCallRequestSchema },
  { name: 'ToolCallResult', schema: ToolCallResultSchema },
  { name: 'VerificationResult', schema: VerificationResultSchema },
  { name: 'ResearchOutput', schema: ResearchOutputSchema },
  { name: 'ResearchResult', schema: ResearchResultSchema },
];

const VALID_PLAN = {
  objective: 'objective',
  summary: 'summary',
  tasks: [
    {
      id: 't1',
      name: 'task',
      description: 'description',
      assignedAgent: 'researcher',
      tools: [],
      dependsOn: [],
      expectedOutcome: 'outcome',
    },
  ],
};

describe('Zod structured schemas', () => {
  it('accepts a valid AgentPlan', () => {
    const result = AgentPlanSchema.safeParse(VALID_PLAN);
    expect(result.success).toBe(true);
  });

  it('rejects an AgentPlan with no tasks', () => {
    const result = AgentPlanSchema.safeParse({
      objective: 'o',
      summary: 's',
      tasks: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a PlannedTask with an unassigned agent', () => {
    const result = PlannedTaskSchema.safeParse({
      id: 't1',
      name: 'task',
      description: 'd',
      assignedAgent: 'wizard',
      tools: [],
      dependsOn: [],
      expectedOutcome: 'e',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a PlannedTask with a missing expected outcome', () => {
    const result = PlannedTaskSchema.safeParse({
      id: 't1',
      name: 'task',
      description: 'd',
      assignedAgent: 'builder',
      tools: [],
      dependsOn: [],
    });
    expect(result.success).toBe(false);
  });

  it('applies defaults for optional list fields', () => {
    const result = PlannedTaskSchema.safeParse({
      id: 't1',
      name: 'task',
      description: 'd',
      assignedAgent: 'builder',
      expectedOutcome: 'e',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual([]);
      expect(result.data.dependsOn).toEqual([]);
    }
  });

  it('accepts a valid ToolCallRequest with record arguments', () => {
    const result = ToolCallRequestSchema.safeParse({
      id: 'c1',
      tool: 'calculator',
      arguments: { operation: 'add', a: 1, b: 2, nested: { x: 1 } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ToolCallRequest without arguments', () => {
    const result = ToolCallRequestSchema.safeParse({
      id: 'c1',
      tool: 'calculator',
    });
    expect(result.success).toBe(false);
  });

  it('accepts successful and failed ToolCallResults', () => {
    const ok = ToolCallResultSchema.safeParse({
      id: 'c1',
      tool: 'calculator',
      ok: true,
      output: 3,
      durationMs: 4,
    });
    expect(ok.success).toBe(true);
    const failed = ToolCallResultSchema.safeParse({
      id: 'c1',
      tool: 'calculator',
      ok: false,
      error: 'division by zero',
    });
    expect(failed.success).toBe(true);
    const invalid = ToolCallResultSchema.safeParse({
      id: 'c1',
      tool: 'calculator',
    });
    expect(invalid.success).toBe(false);
  });

  it('accepts a valid AgentResult', () => {
    const result = AgentResultSchema.safeParse({
      taskId: 'task-1',
      agent: 'builder',
      status: 'succeeded',
      summary: 'done',
      artifacts: ['file.ts'],
      toolCalls: [
        { id: 'c1', tool: 'calculator', ok: true, output: 5 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an AgentResult with an unknown status', () => {
    const result = AgentResultSchema.safeParse({
      taskId: 'task-1',
      agent: 'builder',
      status: 'maybe',
      summary: 'done',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a VerificationResult with structured issues', () => {
    const result = VerificationResultSchema.safeParse({
      passed: false,
      summary: 'failed verification',
      score: 42,
      issues: [
        { severity: 'error', message: 'missing section' },
        { severity: 'warning', message: 'consider rewriting' },
      ],
      evidence: ['evidence-1'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a VerificationResult with an out-of-range score', () => {
    const result = VerificationResultSchema.safeParse({
      passed: true,
      summary: 'ok',
      score: 101,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a VerificationResult issue with an unknown severity', () => {
    const result = VerificationResultSchema.safeParse({
      passed: true,
      summary: 'ok',
      issues: [{ severity: 'fatal', message: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a ResearchOutput with tool call requests', () => {
    const result = ResearchOutputSchema.safeParse({
      topic: 't',
      summary: 's',
      findings: ['f1', 'f2'],
      taskId: 'task-1',
      toolCallRequests: [
        { id: 'c1', tool: 'word_count', arguments: { text: 'hi' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ResearchOutput with no findings', () => {
    const result = ResearchOutputSchema.safeParse({
      topic: 't',
      summary: 's',
      findings: [],
      taskId: 'task-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('validateStructured helper', () => {
  it('returns the parsed value for valid output', () => {
    const result = validateStructured(AgentPlanSchema, VALID_PLAN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objective).toBe('objective');
    }
  });

  it('returns readable issues for invalid output', () => {
    const result = validateStructured(AgentPlanSchema, {
      objective: 'only an objective',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(' ')).toContain('summary');
    }
  });
});

describe('deterministic structured generation covers every schema', () => {
  for (const { name, schema } of STRUCTURED_SCHEMAS) {
    it(`generates schema-valid ${name} output across many seeds`, async () => {
      const provider = new DeterministicLLMProvider();
      for (let seed = 0; seed < 15; seed++) {
        const completion = await provider.generateStructured({
          prompt: `generate a ${name} for seed ${seed}`,
          schema,
          intent: name.toLowerCase(),
          options: { seed },
        });
        // generateStructured only resolves with schema-valid output.
        expect(completion.value).toBeDefined();
      }
    });
  }
});

describe('invalid model output handling', () => {
  it('throws StructuredOutputError when the model violates the schema', async () => {
    const provider = new DeterministicLLMProvider({
      responses: {
        plan: { not: 'a plan' },
      },
    });
    await expect(
      provider.generateStructured({
        prompt: 'plan',
        schema: AgentPlanSchema,
        intent: 'plan',
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it('reports the exact validation issues of invalid model output', async () => {
    const provider = new DeterministicLLMProvider({
      responses: {
        plan: { objective: 'o', summary: 's', tasks: 'not-an-array' },
      },
    });
    const error = await provider
      .generateStructured({
        prompt: 'plan',
        schema: AgentPlanSchema,
        intent: 'plan',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    const structured = error as StructuredOutputError;
    expect(structured.code).toBe('structured_output');
    expect(structured.issues.join(' ')).toContain('tasks');
  });
});
