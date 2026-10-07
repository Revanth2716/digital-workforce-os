import { describe, expect, it } from 'vitest';
import type { Agent, AgentContext, AgentOutput } from '../src/agents/agent.js';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { PlannerAgent } from '../src/agents/planner-agent.js';
import { ResearcherAgent } from '../src/agents/researcher-agent.js';
import { BuilderAgent } from '../src/agents/builder-agent.js';
import { VerifierAgent } from '../src/agents/verifier-agent.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import {
  CalculatorTool,
  WordCountTool,
} from '../src/tools/builtin-tools.js';
import type { Tool, ToolContext, Schema } from '../src/tools/tool.js';
import { TypedEventBus } from '../src/events/event-bus.js';
import { EvidenceLog } from '../src/events/evidence.js';
import {
  DeterministicIdGenerator,
  FakeClock,
} from '../src/core/types.js';
import type { RunId, TaskId } from '../src/core/types.js';
import type { JsonValue } from '../src/core/json.js';
import { isJsonObject } from '../src/core/json.js';
import { ValidationError } from '../src/core/errors.js';
import {
  DeterministicLLMProvider,
} from '../src/providers/deterministic-llm-provider.js';
import type { LLMProvider } from '../src/providers/llm-provider.js';
import type {
  AgentPlan,
  AgentResult,
  ResearchResult,
  VerificationResult,
} from '../src/agents/schemas.js';

/** A stub specialist agent, for registry completeness. */
class StubAgent implements Agent {
  constructor(
    readonly name: string,
    readonly capabilities: readonly string[],
  ) {}
  async execute(_input: JsonValue, _context: AgentContext): Promise<AgentOutput> {
    return { output: null, summary: 'stub' };
  }
}

interface Harness {
  readonly bus: TypedEventBus;
  readonly ids: DeterministicIdGenerator;
  readonly clock: FakeClock;
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly evidence: EvidenceLog;
  readonly context: AgentContext;
  readonly events: Array<{ kind: string; data: Record<string, unknown> }>;
}

function makeHarness(providerOptions?: {
  readonly responses?: Record<string, JsonValue>;
}): Harness {
  const bus = new TypedEventBus();
  const ids = new DeterministicIdGenerator('ai');
  const clock = new FakeClock();
  const tools = new ToolRegistry();
  tools.register(new CalculatorTool());
  tools.register(new WordCountTool());
  const agents = new AgentRegistry();
  agents.register(new StubAgent('researcher', ['research']));
  agents.register(new StubAgent('builder', ['implementation']));
  agents.register(new StubAgent('verifier', ['verification']));
  const evidence = new EvidenceLog(bus, ids, clock);

  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  bus.on('evidence.recorded', (event) => {
    const payload = event.payload as { kind: string; data: Record<string, unknown> };
    events.push({ kind: payload.kind, data: payload.data });
  });

  const context: AgentContext = {
    runId: 'run-ai-test' as RunId,
    taskId: 'task-ai-test' as TaskId,
    attempt: 1,
    signal: new AbortController().signal,
    clock,
    tools,
    evidence,
    objective: 'test objective',
    previousResults: [],
    availableTools: tools.list().map((tool) => tool.name),
    model: { provider: 'deterministic', name: 'deterministic-1', capabilities: ['text', 'structured-output'] },
  };

  return { bus, ids, clock, tools, agents, evidence, context, events };
}

function kinds(harness: Harness): string[] {
  return harness.events.map((event) => event.kind);
}

/** First element of a non-empty list, or a test failure. */
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('expected at least one element');
  }
  return item;
}

function evidenceOf(
  harness: Harness,
  kind: string,
): Array<Record<string, unknown>> {
  return harness.events
    .filter((event) => event.kind === kind)
    .map((event) => event.data);
}

const PLAN_RESPONSE: JsonValue = {
  objective: 'test objective',
  summary: 'a minimal plan',
  tasks: [
    {
      id: 't1',
      name: 'research',
      description: 'research it',
      assignedAgent: 'researcher',
      tools: ['word_count'],
      dependsOn: [],
      expectedOutcome: 'findings',
    },
    {
      id: 't2',
      name: 'build',
      description: 'build it',
      assignedAgent: 'builder',
      tools: ['calculator'],
      dependsOn: ['t1'],
      expectedOutcome: 'artifacts',
    },
    {
      id: 't3',
      name: 'verify',
      description: 'verify it',
      assignedAgent: 'verifier',
      tools: [],
      dependsOn: ['t2'],
      expectedOutcome: 'verdict',
    },
  ],
};

describe('PlannerAgent', () => {
  it('produces a validated AgentPlan from the objective', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { plan: PLAN_RESPONSE },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    const output = await planner.execute(
      { objective: 'test objective', availableTools: ['word_count', 'calculator'] },
      harness.context,
    );

    const plan = output.output as AgentPlan;
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0]?.assignedAgent).toBe('researcher');
    expect(plan.tasks[1]?.dependsOn).toEqual(['t1']);
    expect(plan.tasks[2]?.expectedOutcome).toBe('verdict');
    expect(output.summary).toContain('3 tasks');
  });

  it('records agent, model and validation evidence', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { plan: PLAN_RESPONSE },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    await planner.execute({ objective: 'test objective' }, harness.context);

    expect(kinds(harness)).toEqual([
      'agent.start',
      'model.call',
      'structured.validation',
      'agent.end',
    ]);

    const start = first(evidenceOf(harness, 'agent.start'));
    expect(start['agent']).toBe('planner');
    expect(start['objective']).toBe('test objective');

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['provider']).toBe('deterministic');
    expect(modelCall['model']).toBe('deterministic-1');
    expect(modelCall['intent']).toBe('plan');
    expect(typeof modelCall['promptTokens']).toBe('number');
    expect(typeof modelCall['totalTokens']).toBe('number');
    expect(modelCall['requestHash']).toMatch(/^[a-f0-9]{64}$/);

    const validation = first(evidenceOf(harness, 'structured.validation'));
    expect(validation['schema']).toBe('AgentPlan');
    expect(validation['ok']).toBe(true);

    const end = first(evidenceOf(harness, 'agent.end'));
    expect(end['status']).toBe('succeeded');
  });

  it('rejects an input without an objective', async () => {
    const harness = makeHarness();
    const planner = new PlannerAgent(
      new DeterministicLLMProvider(),
      harness.agents,
    );
    await expect(planner.execute({ topic: 'no objective' }, harness.context)).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects a plan that assigns an unregistered agent', async () => {
    const harness = makeHarness();
    // Only the planner is registered here: the plan's
    // specialist agents are unknown.
    const smallRegistry = new AgentRegistry();
    const provider = new DeterministicLLMProvider({
      responses: { plan: PLAN_RESPONSE },
    });
    const planner = new PlannerAgent(provider, smallRegistry);

    await expect(
      planner.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a plan with an unknown dependency', async () => {
    const harness = makeHarness();
    const brokenPlan = {
      objective: 'test objective',
      summary: 'broken',
      tasks: [
        {
          id: 't1',
          name: 'research',
          description: 'd',
          assignedAgent: 'researcher',
          tools: [],
          dependsOn: ['missing-task'],
          expectedOutcome: 'e',
        },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { plan: brokenPlan },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    await expect(
      planner.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow(/unknown task 'missing-task'/);
  });

  it('rejects a plan with a dependency cycle', async () => {
    const harness = makeHarness();
    const cyclicPlan = {
      objective: 'test objective',
      summary: 'cyclic',
      tasks: [
        {
          id: 't1',
          name: 'a',
          description: 'd',
          assignedAgent: 'researcher',
          tools: [],
          dependsOn: ['t2'],
          expectedOutcome: 'e',
        },
        {
          id: 't2',
          name: 'b',
          description: 'd',
          assignedAgent: 'builder',
          tools: [],
          dependsOn: ['t1'],
          expectedOutcome: 'e',
        },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { plan: cyclicPlan },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    await expect(
      planner.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow(/cycle/);
  });

  it('rejects a plan with duplicate task ids', async () => {
    const harness = makeHarness();
    const duplicatePlan = {
      objective: 'test objective',
      summary: 'duplicated',
      tasks: [
        {
          id: 't1',
          name: 'a',
          description: 'd',
          assignedAgent: 'researcher',
          tools: [],
          dependsOn: [],
          expectedOutcome: 'e',
        },
        {
          id: 't1',
          name: 'b',
          description: 'd',
          assignedAgent: 'builder',
          tools: [],
          dependsOn: [],
          expectedOutcome: 'e',
        },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { plan: duplicatePlan },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    await expect(
      planner.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow(/duplicate task id/);
  });

  it('records unknown tools as warnings but accepts the plan', async () => {
    const harness = makeHarness();
    const planWithUnknownTool = {
      objective: 'test objective',
      summary: 'warning plan',
      tasks: [
        {
          id: 't1',
          name: 'research',
          description: 'd',
          assignedAgent: 'researcher',
          tools: ['nonexistent_tool'],
          dependsOn: [],
          expectedOutcome: 'e',
        },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { plan: planWithUnknownTool },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    const output = await planner.execute(
      { objective: 'test objective' },
      harness.context,
    );
    expect((output.output as AgentPlan).tasks).toHaveLength(1);

    const warnings = harness.events.filter(
      (event) => event.kind === 'plan.warnings',
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0]?.data['warnings'])).toContain(
      'nonexistent_tool',
    );
  });

  it('records failed structured validation when the model output is invalid', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { plan: { objective: 'incomplete' } },
    });
    const planner = new PlannerAgent(provider, harness.agents);

    await expect(
      planner.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow();

    const validation = first(evidenceOf(harness, 'structured.validation'));
    expect(validation['ok']).toBe(false);
    expect((validation['issues'] as string[]).length).toBeGreaterThan(0);
  });
});

describe('ResearcherAgent', () => {
  const RESEARCH_RESPONSE: JsonValue = {
    topic: 'structured validation',
    summary: 'validation is missing today',
    findings: ['agents emit raw JSON', 'schemas close the gap'],
    sources: ['src/agents/agent.ts'],
    taskId: 'task-ai-test',
    toolCallRequests: [
      {
        id: 'research-1',
        tool: 'word_count',
        arguments: { text: 'structured outputs enable audits' },
      },
    ],
  };

  it('produces structured findings and executes read-only tools', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { research: RESEARCH_RESPONSE },
    });
    const researcher = new ResearcherAgent(provider, harness.tools);

    const output = await researcher.execute(
      {
        objective: 'test objective',
        task: {
          id: 't1',
          name: 'research-task',
          description: 'analyse',
          expectedOutcome: 'findings',
        },
      },
      harness.context,
    );

    const result = output.output as ResearchResult;
    expect(result.topic).toBe('structured validation');
    expect(result.findings).toHaveLength(2);
    expect(result.taskId).toBe('task-ai-test');
    // The word_count tool ran through the structured flow.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.toolCalls[0]?.tool).toBe('word_count');
    expect((result.toolCalls[0]?.output as { words: number }).words).toBe(4);
    expect(output.summary).toContain('validation is missing today');
  });

  it('records the full tool and agent evidence trail', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { research: RESEARCH_RESPONSE },
    });
    const researcher = new ResearcherAgent(provider, harness.tools);

    await researcher.execute(
      { objective: 'test objective', task: { name: 't', description: 'd', expectedOutcome: 'e' } },
      harness.context,
    );

    expect(kinds(harness)).toEqual([
      'agent.start',
      'model.call',
      'structured.validation',
      'tool.call',
      'tool.result',
      'structured.validation',
      'agent.end',
    ]);
  });

  it('refuses side-effecting tools (read-only agent)', async () => {
    const harness = makeHarness();
    class PublishTool implements Tool {
      readonly name = 'publish';
      readonly description = 'side effect';
      readonly inputSchema: Schema = { type: 'object', properties: {} };
      readonly readOnly = false;
      async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
        return { published: true };
      }
    }
    harness.tools.register(new PublishTool());
    const response: JsonValue = {
      topic: 't',
      summary: 's',
      findings: ['f'],
      taskId: 'task-ai-test',
      toolCallRequests: [
        { id: 'r1', tool: 'publish', arguments: {} },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { research: response },
    });
    const researcher = new ResearcherAgent(provider, harness.tools);

    const output = await researcher.execute(
      { objective: 'test objective' },
      harness.context,
    );
    const result = output.output as ResearchResult;
    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.toolCalls[0]?.error).toContain('read-only');
  });

  it('includes previous results in the model prompt context', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { research: RESEARCH_RESPONSE },
    });
    const researcher = new ResearcherAgent(provider, harness.tools);
    const context: AgentContext = {
      ...harness.context,
      previousResults: [{ agent: 'upstream', summary: 'upstream result' }],
    };

    await researcher.execute({ objective: 'test objective' }, context);

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['previousResults']).toBe(1);
  });

  it('propagates invalid model output as StructuredOutputError', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { research: { topic: 't' } },
    });
    const researcher = new ResearcherAgent(provider, harness.tools);

    await expect(
      researcher.execute({ objective: 'test objective' }, harness.context),
    ).rejects.toThrow(/failed schema validation|StructuredOutput/);

    const validation = first(evidenceOf(harness, 'structured.validation'));
    expect(validation['ok']).toBe(false);
  });
});

describe('BuilderAgent', () => {
  const BUILD_RESPONSE: JsonValue = {
    summary: 'implemented the schema module',
    artifacts: ['src/agents/schemas.ts'],
    toolCallRequests: [
      {
        id: 'build-1',
        tool: 'calculator',
        arguments: { operation: 'add', a: 2, b: 3 },
      },
    ],
  };

  const REPAIR_RESPONSE: JsonValue = {
    summary: 'repaired the schema module',
    artifacts: ['src/agents/schemas.ts', 'tests/ai.test.ts'],
    toolCallRequests: [
      {
        id: 'repair-1',
        tool: 'calculator',
        arguments: { operation: 'multiply', a: 6, b: 7 },
      },
    ],
  };

  it('performs implementation tasks and returns a structured AgentResult', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { build: BUILD_RESPONSE },
    });
    const builder = new BuilderAgent(provider, harness.tools);

    const output = await builder.execute(
      {
        objective: 'test objective',
        task: {
          id: 't2',
          name: 'build-task',
          description: 'implement',
          expectedOutcome: 'artifacts',
        },
      },
      harness.context,
    );

    const result = output.output as AgentResult;
    expect(result.agent).toBe('builder');
    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe('task-ai-test');
    expect(result.artifacts).toEqual(['src/agents/schemas.ts']);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.toolCalls[0]?.output).toBe(5);
    expect(output.summary).toContain('implemented the schema module');
  });

  it('switches to the repair intent when a failure report is present', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: {
        build: BUILD_RESPONSE,
        'build:repair': REPAIR_RESPONSE,
      },
    });
    const builder = new BuilderAgent(provider, harness.tools);
    const failure: JsonValue = {
      passed: false,
      summary: 'verification failed',
      issues: [{ severity: 'error', message: 'missing defaults' }],
    };

    const output = await builder.execute(
      {
        objective: 'test objective',
        task: { id: 't2', name: 'build-task', description: 'implement', expectedOutcome: 'artifacts' },
        cycle: 1,
        failure,
      },
      harness.context,
    );

    const result = output.output as AgentResult;
    // The scripted repair response was used, not the first-attempt one.
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts).toContain('tests/ai.test.ts');
    expect(result.toolCalls[0]?.output).toBe(42);

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['intent']).toBe('build:repair');
  });

  it('keeps the build intent when no failure is reported', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: {
        build: BUILD_RESPONSE,
        'build:repair': REPAIR_RESPONSE,
      },
    });
    const builder = new BuilderAgent(provider, harness.tools);

    await builder.execute(
      {
        objective: 'test objective',
        task: { id: 't2', name: 'build-task', description: 'implement', expectedOutcome: 'artifacts' },
        cycle: 0,
      },
      harness.context,
    );

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['intent']).toBe('build');
  });

  it('reports tool failures inside the result without failing the task', async () => {
    const harness = makeHarness();
    const response: JsonValue = {
      summary: 'attempted a bad call',
      artifacts: [],
      toolCallRequests: [
        { id: 'bad-1', tool: 'calculator', arguments: { operation: 'divide', a: 1, b: 0 } },
      ],
    };
    const provider = new DeterministicLLMProvider({
      responses: { build: response },
    });
    const builder = new BuilderAgent(provider, harness.tools);

    const output = await builder.execute(
      { objective: 'test objective' },
      harness.context,
    );

    const result = output.output as AgentResult;
    expect(result.status).toBe('succeeded');
    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.toolCalls[0]?.error).toContain('division by zero');
  });

  it('records the complete evidence trail including tool calls', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { build: BUILD_RESPONSE },
    });
    const builder = new BuilderAgent(provider, harness.tools);

    await builder.execute({ objective: 'test objective' }, harness.context);

    expect(kinds(harness)).toEqual([
      'agent.start',
      'model.call',
      'structured.validation',
      'tool.call',
      'tool.result',
      'structured.validation',
      'agent.end',
    ]);
  });
});

describe('VerifierAgent', () => {
  const FAIL_RESPONSE: JsonValue = {
    passed: false,
    summary: 'acceptance criteria not met',
    score: 35,
    issues: [
      { severity: 'error', message: 'missing structured validation' },
      { severity: 'warning', message: 'add tests' },
    ],
    evidence: ['evidence-1'],
  };

  const PASS_RESPONSE: JsonValue = {
    passed: true,
    summary: 'all criteria met',
    score: 97,
    issues: [],
    evidence: [],
  };

  it('returns a structured pass/fail verdict', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { 'verify:0': FAIL_RESPONSE },
    });
    const verifier = new VerifierAgent(provider);

    const output = await verifier.execute(
      {
        objective: 'test objective',
        task: { id: 't3', name: 'verify-task', description: 'verify', expectedOutcome: 'verdict' },
        cycle: 0,
      },
      harness.context,
    );

    const result = output.output as VerificationResult;
    expect(result.passed).toBe(false);
    expect(result.score).toBe(35);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.severity).toBe('error');
    expect(output.summary).toBe('acceptance criteria not met');
  });

  it('uses the cycle-scoped verify intent', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { 'verify:0': FAIL_RESPONSE, 'verify:1': PASS_RESPONSE },
    });
    const verifier = new VerifierAgent(provider);

    await verifier.execute(
      { objective: 'test objective', cycle: 0 },
      harness.context,
    );
    await verifier.execute(
      { objective: 'test objective', cycle: 1 },
      { ...harness.context, taskId: 'task-ai-test-2' as TaskId },
    );

    const modelCalls = evidenceOf(harness, 'model.call');
    expect(modelCalls[0]?.['intent']).toBe('verify:0');
    expect(modelCalls[1]?.['intent']).toBe('verify:1');
  });

  it('records a verification evidence record with the verdict', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { 'verify:0': FAIL_RESPONSE },
    });
    const verifier = new VerifierAgent(provider);

    await verifier.execute({ objective: 'test objective', cycle: 0 }, harness.context);

    const verification = first(evidenceOf(harness, 'verification'));
    expect(verification['passed']).toBe(false);
    expect(verification['score']).toBe(35);
    expect(verification['issueCount']).toBe(2);
    expect(verification['errorCount']).toBe(1);
    expect(verification['cycle']).toBe(0);
  });

  it('includes previous results in the verification prompt', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { 'verify:0': PASS_RESPONSE },
    });
    const verifier = new VerifierAgent(provider);
    const context: AgentContext = {
      ...harness.context,
      previousResults: [
        { agent: 'researcher', summary: 'findings' },
        { agent: 'builder', summary: 'artifacts' },
      ],
    };

    await verifier.execute({ objective: 'test objective', cycle: 0 }, context);

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['previousResults']).toBe(2);
  });

  it('records agent start/end and model metadata', async () => {
    const harness = makeHarness();
    const provider = new DeterministicLLMProvider({
      responses: { 'verify:0': PASS_RESPONSE },
    });
    const verifier = new VerifierAgent(provider);

    await verifier.execute({ objective: 'test objective', cycle: 0 }, harness.context);

    expect(kinds(harness)).toEqual([
      'agent.start',
      'model.call',
      'structured.validation',
      'verification',
      'agent.end',
    ]);
    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['model']).toBe('deterministic-1');
  });
});

describe('AI agents share the provider-neutral seam', () => {
  it('every specialist agent works against any LLMProvider', async () => {
    // A minimal alternative provider proves agents depend on
    // the LLMProvider interface, not a concrete class.
    class AlternativeProvider implements LLMProvider {
      readonly name = 'alternative';
      readonly model = {
        provider: 'alternative',
        name: 'alt-1',
        capabilities: ['text', 'structured-output'] as const,
      };
      async complete(): Promise<never> {
        throw new Error('not used in this test');
      }
      async generateStructured<T>(): Promise<import('../src/providers/llm-provider.js').StructuredCompletion<T>> {
        return {
          value: PLAN_RESPONSE as unknown as T,
          provider: this.name,
          model: this.model.name,
          finishReason: 'completed',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          requestHash: 'alt',
        };
      }
    }

    const harness = makeHarness();
    const planner = new PlannerAgent(new AlternativeProvider(), harness.agents);
    const output = await planner.execute({ objective: 'o' }, harness.context);
    expect((output.output as AgentPlan).tasks).toHaveLength(3);

    const modelCall = first(evidenceOf(harness, 'model.call'));
    expect(modelCall['provider']).toBe('alternative');
    expect(modelCall['model']).toBe('alt-1');
  });
});

describe('agent context carries AI-layer state without global mutable state', () => {
  it('exposes objective, previous results, tools and model metadata', () => {
    const harness = makeHarness();
    const context = harness.context;
    expect(context.objective).toBe('test objective');
    expect(context.previousResults).toEqual([]);
    expect(context.availableTools).toContain('calculator');
    expect(context.availableTools).toContain('word_count');
    expect(context.model?.name).toBe('deterministic-1');
    // M1 fields remain intact.
    expect(context.runId).toBe('run-ai-test');
    expect(context.taskId).toBe('task-ai-test');
    expect(context.attempt).toBe(1);
    expect(context.tools).toBeInstanceOf(ToolRegistry);
    expect(context.evidence).toBeInstanceOf(EvidenceLog);
  });

  it('isJsonObject guards keep inputs defensive', () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([1])).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });
});
