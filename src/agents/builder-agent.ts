import type { Agent, AgentContext, AgentOutput } from './agent.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson, isJsonObject } from '../core/json.js';
import { ValidationError } from '../core/errors.js';
import { fnv1a32 } from '../providers/random.js';
import type { AgentResult, BuilderOutput, VerificationResult } from './schemas.js';
import {
  AgentResultSchema,
  BuilderOutputSchema,
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
 * The builder agent (Milestone 2).
 *
 * Performs implementation-oriented tasks. It requests
 * tools through the structured tool-calling flow and
 * returns a Zod-validated `AgentResult` carrying its
 * artefacts and the executed tool calls as evidence.
 *
 * During a repair cycle the task input carries the
 * verifier's `failure` report; the builder then
 * switches to the `build:repair` intent so providers
 * (and scripted offline scenarios) can produce a
 * targeted repair instead of a fresh attempt.
 */
export class BuilderAgent implements Agent {
  readonly name = 'builder';
  readonly capabilities = ['implementation', 'building'] as const;

  private readonly toolCaller: ToolCaller;

  constructor(
    private readonly provider: LLMProvider,
    tools: ToolRegistry,
  ) {
    this.toolCaller = new ToolCaller(tools);
  }

  async execute(
    input: JsonValue,
    context: AgentContext,
  ): Promise<AgentOutput> {
    context.signal.throwIfAborted();
    const objective = extractObjective(input);
    if (objective === undefined) {
      throw new ValidationError('BuilderAgent requires an objective in its input');
    }
    const task = inputField<{
      readonly id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly expectedOutcome?: string;
    }>(input, 'task');
    const failure = inputField<VerificationResult>(input, 'failure');
    const cycle = inputField<number>(input, 'cycle') ?? 0;
    const isRepair = failure !== undefined && isJsonObject(failure as unknown as JsonValue);
    const intent = isRepair ? 'build:repair' : 'build';

    const startedAt = context.clock.now();
    recordAgentStart(context.evidence, context, this.name, objective);

    const prompt = [
      'You are the builder agent for a governed multi-agent workflow system.',
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
      ...(isRepair
        ? [
            'REPAIR INSTRUCTION: the verifier rejected the previous attempt.',
            `Failure report (cycle ${cycle}):`,
            canonicalJson(failure as unknown as JsonValue),
            'Address every reported issue and repair the implementation.',
            '',
          ]
        : []),
      'Perform the implementation task. Request tools as needed and',
      'produce a structured result as JSON matching the builder output',
      'schema. List every artefact you produced.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const completion = await generateAndRecord<BuilderOutput>(
      this.provider,
      context,
      'BuilderOutput',
      {
        prompt,
        schema: BuilderOutputSchema,
        intent,
        options: { seed: fnv1a32(context.taskId) },
      },
      { previousResults: context.previousResults?.length ?? 0 },
    );
    context.signal.throwIfAborted();

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

    const result: AgentResult = {
      taskId: context.taskId,
      agent: this.name,
      status: 'succeeded',
      summary: completion.value.summary,
      artifacts: completion.value.artifacts,
      toolCalls,
    };

    const validated = validateStructured(AgentResultSchema, result);
    if (!validated.ok) {
      recordStructuredValidation(
        context.evidence,
        context,
        'AgentResult',
        intent,
        false,
        validated.issues,
      );
      recordAgentEnd(context.evidence, context, this.name, 'failed', context.clock.now() - startedAt);
      throw new ValidationError(
        `Builder result failed validation: ${validated.issues.join('; ')}`,
      );
    }
    recordStructuredValidation(
      context.evidence,
      context,
      'AgentResult',
      intent,
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
      summary: `Built: ${validated.value.summary}`,
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
