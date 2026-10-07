import type { Agent, AgentContext, AgentOutput } from './agent.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';
import { ValidationError } from '../core/errors.js';
import { fnv1a32 } from '../providers/random.js';
import type { VerificationResult } from './schemas.js';
import {
  VerificationResultSchema,
  validateStructured,
} from './schemas.js';
import {
  extractObjective,
  generateAndRecord,
  inputField,
  recordAgentEnd,
  recordAgentStart,
} from './agent-support.js';

/**
 * The verifier agent (Milestone 2).
 *
 * Inspects the results produced so far (through the
 * agent context) against the objective and the
 * task's expected outcome, and returns a
 * Zod-validated `VerificationResult`: a pass/fail
 * verdict plus structured failure information
 * (severity-tagged issues, score, evidence
 * references) that the repair cycle consumes.
 *
 * The verification cycle (0 = first pass, 1 =
 * after one repair) is part of the task input and
 * selects the `verify:<cycle>` intent.
 */
export class VerifierAgent implements Agent {
  readonly name = 'verifier';
  readonly capabilities = ['verification'] as const;

  constructor(private readonly provider: LLMProvider) {}

  async execute(
    input: JsonValue,
    context: AgentContext,
  ): Promise<AgentOutput> {
    context.signal.throwIfAborted();
    const objective = extractObjective(input);
    if (objective === undefined) {
      throw new ValidationError('VerifierAgent requires an objective in its input');
    }
    const task = inputField<{
      readonly id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly expectedOutcome?: string;
    }>(input, 'task');
    const cycle = inputField<number>(input, 'cycle') ?? 0;
    const intent = `verify:${cycle}`;

    const startedAt = context.clock.now();
    recordAgentStart(context.evidence, context, this.name, objective);

    const prompt = [
      'You are the verifier agent for a governed multi-agent workflow system.',
      '',
      `Objective: ${objective}`,
      task?.name !== undefined ? `Task: ${task.name}` : null,
      task?.expectedOutcome !== undefined
        ? `Expected outcome: ${task.expectedOutcome}`
        : null,
      cycle > 0 ? `Verification cycle: ${cycle} (post-repair)` : null,
      '',
      'Results produced so far:',
      ...previousResultsLines(context),
      '',
      'Verify the results against the objective and the expected',
      'outcome. Respond with JSON matching the verification result',
      'schema: `passed`, a `summary`, an optional `score` (0-100),',
      '`issues` (each with severity and message) and `evidence`',
      'references. Be strict: any unmet acceptance criterion is an',
      'error-level issue and fails verification.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const completion = await generateAndRecord<VerificationResult>(
      this.provider,
      context,
      'VerificationResult',
      {
        prompt,
        schema: VerificationResultSchema,
        intent,
        options: { seed: fnv1a32(context.taskId) },
      },
      { previousResults: context.previousResults?.length ?? 0 },
    );
    context.signal.throwIfAborted();

    const verification = completion.value;
    context.evidence.record({
      runId: context.runId,
      taskId: context.taskId,
      kind: 'verification',
      data: {
        passed: verification.passed,
        score: verification.score ?? null,
        issueCount: verification.issues.length,
        errorCount: verification.issues.filter((issue) => issue.severity === 'error').length,
        cycle,
        summary: verification.summary,
      },
    });

    recordAgentEnd(
      context.evidence,
      context,
      this.name,
      'succeeded',
      context.clock.now() - startedAt,
    );

    return {
      output: verification as unknown as JsonValue,
      summary: verification.summary,
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
