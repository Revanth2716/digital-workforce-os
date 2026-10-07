import type { JsonValue } from '../core/json.js';
import { isJsonObject } from '../core/json.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { AgentContext } from './agent.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type {
  CompletionUsage,
} from '../providers/provider.js';
import type {
  StructuredCompletion,
  StructuredCompletionRequest,
} from '../providers/llm-provider.js';
import { StructuredOutputError } from '../core/errors.js';

/** Record the start of an agent execution. */
export function recordAgentStart(
  evidence: EvidenceLog,
  context: AgentContext,
  agent: string,
  objective?: string,
): void {
  evidence.record({
    runId: context.runId,
    taskId: context.taskId,
    kind: 'agent.start',
    data: {
      agent,
      taskId: context.taskId,
      attempt: context.attempt,
      objective: objective ?? null,
    },
  });
}

/** Record the end of an agent execution. */
export function recordAgentEnd(
  evidence: EvidenceLog,
  context: AgentContext,
  agent: string,
  status: 'succeeded' | 'failed',
  durationMs: number,
): void {
  evidence.record({
    runId: context.runId,
    taskId: context.taskId,
    kind: 'agent.end',
    data: { agent, taskId: context.taskId, attempt: context.attempt, status, durationMs },
  });
}

/** Record a model call with token/usage metadata. */
export function recordModelCall(
  evidence: EvidenceLog,
  context: AgentContext,
  completion: {
    readonly provider: string;
    readonly model: string;
    readonly usage: CompletionUsage;
    readonly requestHash: string;
  },
  intent: string,
  extra: { readonly previousResults?: number } = {},
): void {
  evidence.record({
    runId: context.runId,
    taskId: context.taskId,
    kind: 'model.call',
    data: {
      provider: completion.provider,
      model: completion.model,
      intent,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      totalTokens: completion.usage.totalTokens,
      requestHash: completion.requestHash,
      previousResults: extra.previousResults ?? 0,
    },
  });
}

/**
 * Generate structured output through an LLM provider and
 * record the call and validation evidence for both
 * outcomes.
 *
 * Every model-generated structured output passes through
 * here, so the evidence log always shows the model call
 * (with token/usage metadata) and whether the model's
 * output validated against its schema — including the
 * failure case, where the `StructuredOutputError`
 * (with its issues) is rethrown after being recorded.
 */
export async function generateAndRecord<T>(
  provider: LLMProvider,
  context: AgentContext,
  schemaName: string,
  request: StructuredCompletionRequest,
  extra: { readonly previousResults?: number } = {},
): Promise<StructuredCompletion<T>> {
  const intent = request.intent ?? 'default';
  let completion: StructuredCompletion<T>;
  try {
    completion = await provider.generateStructured<T>(request);
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      recordStructuredValidation(
        context.evidence,
        context,
        schemaName,
        intent,
        false,
        error.issues,
      );
    }
    throw error;
  }
  recordModelCall(context.evidence, context, completion, intent, extra);
  recordStructuredValidation(
    context.evidence,
    context,
    schemaName,
    intent,
    true,
  );
  return completion;
}

/** Record structured-output validation for a schema. */
export function recordStructuredValidation(
  evidence: EvidenceLog,
  context: AgentContext,
  schemaName: string,
  intent: string,
  ok: boolean,
  issues: readonly string[] = [],
): void {
  evidence.record({
    runId: context.runId,
    taskId: context.taskId,
    kind: 'structured.validation',
    data: { schema: schemaName, intent, ok, issues: ok ? [] : [...issues] },
  });
}

/** Extract the objective from a string or object task input. */
export function extractObjective(input: JsonValue): string | undefined {
  if (typeof input === 'string') return input;
  if (isJsonObject(input)) {
    const objective = input['objective'];
    if (typeof objective === 'string') return objective;
  }
  return undefined;
}

/** Read a field from an object task input, if present. */
export function inputField<T>(input: JsonValue, key: string): T | undefined {
  if (isJsonObject(input)) {
    return input[key] as T | undefined;
  }
  return undefined;
}

/** Describe the executing model for prompts and summaries. */
export function describeModel(provider: LLMProvider): string {
  const model = provider.model;
  return `${model.provider}/${model.name}${model.version ? `@${model.version}` : ''}`;
}
