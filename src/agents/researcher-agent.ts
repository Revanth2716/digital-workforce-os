import type { Agent, AgentContext, AgentOutput } from './agent.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';
import { ValidationError } from '../core/errors.js';
import { fnv1a32 } from '../providers/random.js';
import type {
  ResearchOutput,
  ResearchResult,
} from './schemas.js';
import {
  ResearchOutputSchema,
  ResearchResultSchema,
  validateStructured,
} from './schemas.js';
import { ToolCaller } from './tool-caller.js';
import {
  extractObjective,
  generateAndRecord,
  inputField,
  recordAgentEnd,
  recordAgentStart,
  recordStructuredValidation,
} from './agent-support.js';

/**
 * The researcher agent (Milestone 2).
 *
 * Analyses the objective and its task, produces
 * structured findings, and gathers data through
 * read-only tools only (tools must be explicitly
 * marked `readOnly`). Its structured output is
 * Zod-validated at the provider boundary and again
 * after tool execution.
 */
export class ResearcherAgent implements Agent {
  readonly name = 'researcher';
  readonly capabilities = ['research', 'analysis'] as const;

  private readonly toolCaller: ToolCaller;

  constructor(
    private readonly provider: LLMProvider,
    tools: ToolRegistry,
  ) {
    // The researcher is a read-only agent: it may only
    // invoke tools explicitly marked read-only.
    this.toolCaller = new ToolCaller(tools, { readOnlyOnly: true });
  }

  async execute(
    input: JsonValue,
    context: AgentContext,
  ): Promise<AgentOutput> {
    context.signal.throwIfAborted();
    const objective = extractObjective(input);
    if (objective === undefined) {
      throw new ValidationError('ResearcherAgent requires an objective in its input');
    }
    const task = inputField<{
      readonly id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly expectedOutcome?: string;
    }>(input, 'task');

    const startedAt = context.clock.now();
    recordAgentStart(context.evidence, context, this.name, objective);

    const prompt = [
      'You are the research agent for a governed multi-agent workflow system.',
      '',
      `Objective: ${objective}`,
      task?.name !== undefined ? `Task: ${task.name}` : null,
      task?.description !== undefined ? `Description: ${task.description}` : null,
      task?.expectedOutcome !== undefined
        ? `Expected outcome: ${task.expectedOutcome}`
        : null,
      '',
      'Previous results:',
      ...previousResultsLines(context),
      '',
      'Analyse the objective and produce structured findings as JSON',
      'matching the research output schema. You may request read-only',
      'tools (e.g. word_count) to gather data. Keep findings concise and',
      'cite the sources you relied on.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const completion = await generateAndRecord<ResearchOutput>(
      this.provider,
      context,
      'ResearchOutput',
      {
        prompt,
        schema: ResearchOutputSchema,
        intent: 'research',
        options: { seed: fnv1a32(context.taskId) },
      },
      { previousResults: context.previousResults?.length ?? 0 },
    );
    context.signal.throwIfAborted();

    // Execute the model's tool requests through the
    // structured flow: request -> registry validation
    // -> execution -> result -> evidence.
    const toolCalls = await this.toolCaller.callAll(
      completion.value.toolCallRequests,
      {
        runId: context.runId,
        taskId: context.taskId,
        clock: context.clock,
        signal: context.signal,
        evidence: context.evidence,
      },
    );

    const result: ResearchResult = {
      topic: completion.value.topic,
      summary: completion.value.summary,
      findings: completion.value.findings,
      sources: completion.value.sources,
      taskId: context.taskId,
      toolCalls,
    };

    // Validate the assembled result (model output + tool
    // evidence) before it leaves the agent.
    const validated = validateStructured(ResearchResultSchema, result);
    if (!validated.ok) {
      recordStructuredValidation(
        context.evidence,
        context,
        'ResearchResult',
        'research',
        false,
        validated.issues,
      );
      recordAgentEnd(context.evidence, context, this.name, 'failed', context.clock.now() - startedAt);
      throw new ValidationError(
        `Research result failed validation: ${validated.issues.join('; ')}`,
      );
    }
    recordStructuredValidation(
      context.evidence,
      context,
      'ResearchResult',
      'research',
      true,
    );

    recordAgentEnd(
      context.evidence,
      context,
      this.name,
      'succeeded',
      context.clock.now() - startedAt,
    );

    return {
      output: validated.value as unknown as JsonValue,
      summary: `Research complete: ${validated.value.summary}`,
    };
  }
}

function previousResultsLines(context: AgentContext): string[] {
  const results = context.previousResults;
  if (results === undefined || results.length === 0) {
    return ['(none)'];
  }
  return [canonicalJson(results as unknown as JsonValue)];
}
