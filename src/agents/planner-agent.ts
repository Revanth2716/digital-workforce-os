import type { Agent, AgentContext, AgentOutput } from './agent.js';
import type { AgentRegistry } from './agent-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';
import { ValidationError } from '../core/errors.js';
import { fnv1a32 } from '../providers/random.js';
import type { AgentPlan } from './schemas.js';
import { AgentPlanSchema, validateStructured } from './schemas.js';
import {
  extractObjective,
  generateAndRecord,
  inputField,
  recordAgentEnd,
  recordAgentStart,
  recordStructuredValidation,
} from './agent-support.js';

/**
 * The planner agent (Milestone 2).
 *
 * Input: the user objective plus the available context
 * (registered tools). Output: a Zod-validated
 * `AgentPlan` — tasks, dependencies, the assigned
 * agent per task, the tools each task needs and the
 * expected outcome.
 *
 * The plan is verified against the live registries
 * before it is accepted: every assigned agent must be
 * registered, every dependency must reference a known
 * plan task, task ids must be unique, and the plan
 * must be acyclic. Unknown tools are recorded as
 * warnings in the evidence log.
 */
export class PlannerAgent implements Agent {
  readonly name = 'planner';
  readonly capabilities = ['planning', 'general'] as const;

  constructor(
    private readonly provider: LLMProvider,
    private readonly agents: AgentRegistry,
  ) {}

  async execute(
    input: JsonValue,
    context: AgentContext,
  ): Promise<AgentOutput> {
    context.signal.throwIfAborted();
    const objective = extractObjective(input);
    if (objective === undefined) {
      throw new ValidationError('PlannerAgent requires an objective in its input');
    }
    const availableTools =
      inputField<string[]>(input, 'availableTools') ??
      context.availableTools ??
      context.tools.list().map((tool) => tool.name);

    const startedAt = context.clock.now();
    recordAgentStart(context.evidence, context, this.name, objective);

    const prompt = [
      'You are the planning agent for a governed multi-agent workflow system.',
      '',
      `Objective: ${objective}`,
      '',
      'Available tools:',
      ...availableTools.map((tool) => `- ${tool}`),
      '',
      'Produce an execution plan as JSON matching the AgentPlan schema:',
      '- `tasks`: the units of work, each with a unique id, a name, a',
      '  description, an `assignedAgent` (researcher | builder | verifier),',
      '  the `tools` it needs (by name), its `dependsOn` task ids and its',
      '  `expectedOutcome`.',
      '- Keep the plan minimal and dependency-ordered.',
    ].join('\n');

    const completion = await generateAndRecord<AgentPlan>(
      this.provider,
      context,
      'AgentPlan',
      {
        prompt,
        schema: AgentPlanSchema,
        intent: 'plan',
        options: { seed: fnv1a32(context.taskId) },
      },
      { previousResults: context.previousResults?.length ?? 0 },
    );
    context.signal.throwIfAborted();

    // Verify the plan against the live context before accepting it.
    const issues = verifyPlan(completion.value, this.agents, context.tools);
    if (issues.errors.length > 0) {
      recordStructuredValidation(
        context.evidence,
        context,
        'AgentPlan',
        'plan',
        false,
        issues.errors,
      );
      recordAgentEnd(context.evidence, context, this.name, 'failed', context.clock.now() - startedAt);
      throw new ValidationError(
        `Planner produced an unexecutable plan: ${issues.errors.join('; ')}`,
      );
    }
    if (issues.warnings.length > 0) {
      // Non-fatal: recorded for audit, the plan may still execute.
      context.evidence.record({
        runId: context.runId,
        taskId: context.taskId,
        kind: 'plan.warnings',
        data: { warnings: [...issues.warnings] },
      });
    }

    recordAgentEnd(
      context.evidence,
      context,
      this.name,
      'succeeded',
      context.clock.now() - startedAt,
    );

    const plan = completion.value;
    return {
      output: plan as unknown as JsonValue,
      summary: `Planned ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}: ${plan.summary}`,
    };
  }
}

interface PlanVerification {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Cross-check a plan against the registries and its own
 * dependency graph. Errors make the plan unexecutable;
 * warnings are recorded but tolerated.
 */
export function verifyPlan(
  plan: AgentPlan,
  agents: AgentRegistry,
  tools: ToolRegistry,
): PlanVerification {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      errors.push(`duplicate task id '${task.id}'`);
    }
    ids.add(task.id);
    if (!agents.has(task.assignedAgent)) {
      errors.push(
        `task '${task.id}' assigns unknown agent '${task.assignedAgent}'`,
      );
    }
    for (const tool of task.tools) {
      if (!tools.has(tool)) {
        warnings.push(
          `task '${task.id}' requires unknown tool '${tool}'`,
        );
      }
    }
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        errors.push(
          `task '${task.id}' depends on unknown task '${dep}'`,
        );
      }
    }
  }

  // Cycle detection over the plan's own dependency graph.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: readonly string[]): void => {
    const marked = state.get(id);
    if (marked === 'done') return;
    if (marked === 'visiting') {
      errors.push(`plan dependency cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) return;
    for (const dep of task.dependsOn) {
      visit(dep, [...path, id]);
    }
    state.set(id, 'done');
  };
  for (const task of plan.tasks) {
    visit(task.id, []);
  }

  return { errors, warnings };
}

/** Canonical JSON of the plan, for prompts and evidence. */
export function planToJson(plan: AgentPlan): string {
  return canonicalJson(plan as unknown as JsonValue);
}
