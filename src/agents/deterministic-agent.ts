import type { Agent, AgentContext, AgentOutput } from './agent.js';
import type { Provider } from '../providers/provider.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson, isJsonObject } from '../core/json.js';
import { fnv1a32 } from '../providers/random.js';

/**
 * The only agent in Milestone 1. It delegates "reasoning" to the
 * deterministic provider and may invoke registered tools declared in
 * the task input (`{ tool, args }`), recording evidence for both.
 *
 * Swapping in a real LLM-backed agent later only requires implementing
 * the same Agent interface and registering it under a different name.
 */
export class DeterministicAgent implements Agent {
  readonly name = 'deterministic';
  readonly capabilities = [
    'research',
    'implementation',
    'verification',
    'analysis',
    'general',
  ] as const;

  constructor(private readonly provider: Provider) {}

  async execute(input: JsonValue, context: AgentContext): Promise<AgentOutput> {
    context.signal.throwIfAborted();

    // Optional tool delegation, driven entirely by the task input.
    let toolResult: JsonValue = null;
    if (isJsonObject(input) && typeof input['tool'] === 'string') {
      const toolName = input['tool'] as string;
      const toolArgs = isJsonObject(input['args']) ? (input['args'] as JsonValue) : {};
      toolResult = await context.tools.execute(toolName, toolArgs, {
        signal: context.signal,
        clock: context.clock,
      });
      context.evidence.record({
        runId: context.runId,
        taskId: context.taskId,
        kind: 'tool.invocation',
        data: { tool: toolName, result: toolResult },
      });
    }

    const prompt = `Task input:\n${canonicalJson(input)}`;
    // Seed derived from the task id: identical tasks produce
    // identical completions across runs.
    const completion = await this.provider.complete({
      prompt,
      options: { seed: fnv1a32(context.taskId) },
    });
    context.signal.throwIfAborted();

    context.evidence.record({
      runId: context.runId,
      taskId: context.taskId,
      kind: 'completion',
      data: { requestHash: completion.requestHash, text: completion.text },
    });

    const output: JsonValue = {
      text: completion.text,
      requestHash: completion.requestHash,
      toolResult,
    };
    return { output, summary: completion.text };
  }
}
