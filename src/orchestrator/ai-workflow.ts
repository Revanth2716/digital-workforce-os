import type { AgentContext } from '../agents/agent.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { TypedEventBus } from '../events/event-bus.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { RunRepository } from '../persistence/run-repository.js';
import type { TaskRepository } from '../persistence/task-repository.js';
import type { Clock, IdGenerator, RunId, TaskId } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import { isJsonObject } from '../core/json.js';
import { OrchestrationError, ValidationError } from '../core/errors.js';
import { TaskGraph, createTask } from '../graph/task-graph.js';
import { Orchestrator } from './orchestrator.js';
import type { RunOutcome, TaskOutcome } from './orchestrator.js';
import type { LLMProvider } from '../providers/llm-provider.js';
import type { AgentPlan, PlannedTask, VerificationResult } from '../agents/schemas.js';
import {
  AgentPlanSchema,
  VerificationResultSchema,
  validateStructured,
} from '../agents/schemas.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import type { Skill } from '../skills/skill.js';
import { selectSkills } from '../skills/skill-selector.js';
import { buildRetrievalEvidence } from '../knowledge/context-builder.js';

/** Capability each specialist agent advertises. */
const AGENT_CAPABILITIES: Readonly<Record<string, string>> = {
  researcher: 'research',
  builder: 'implementation',
  verifier: 'verification',
  planner: 'planning',
};

/** The kind of a workflow phase, for display and analysis. */
export type AIPhaseKind =
  | 'planner'
  | 'researcher'
  | 'builder'
  | 'verifier'
  | 'repair'
  | 'agent';

/** One observed phase of an AI workflow run. */
export interface AIPhaseOutcome {
  readonly phase: AIPhaseKind;
  /** Human-readable display label. */
  readonly label: string;
  readonly agent: string;
  readonly taskName: string;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly status: 'succeeded' | 'failed';
  readonly summary: string;
  readonly durationMs: number;
  /** For verifier phases: the verdict, when the output validated. */
  readonly verificationPassed?: boolean;
}

/** Final outcome of an AI workflow. */
export interface AIWorkflowOutcome {
  readonly workflowId: string;
  readonly objective: string;
  readonly status: 'succeeded' | 'failed';
  readonly plan: AgentPlan;
  readonly phases: readonly AIPhaseOutcome[];
  /** The most recent verification result, when a verifier ran. */
  readonly verification?: VerificationResult;
  /** Number of automatic repair cycles executed. */
  readonly repairs: number;
  readonly durationMs: number;
  /** One run outcome per orchestrator run (planner, main, repairs). */
  readonly runs: readonly RunOutcome[];
}

interface FailedVerification {
  readonly planned: PlannedTask;
  readonly task: TaskOutcome;
  readonly result: VerificationResult;
}

/** Dependencies of the AI workflow (all existing M1 seams). */
export interface AIWorkflowDeps {
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly bus: TypedEventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly evidence: EvidenceLog;
  readonly llm: LLMProvider;
  /** Milestone 3: knowledge store for RAG retrieval. */
  readonly knowledgeStore?: KnowledgeStore;
  /** Milestone 3: available skills for selection. */
  readonly skills?: readonly Skill[];
  readonly options?: {
    /** Maximum automatic repair cycles. Defaults to 1 — never infinite. */
    readonly maxRepairCycles?: number;
    /** Concurrency passed to the orchestrator. Defaults to 1. */
    readonly concurrency?: number;
    /** Milestone 3: number of knowledge chunks to retrieve. Defaults to 3. */
    readonly knowledgeTopK?: number;
    /** Milestone 3: number of skills to select. Defaults to 2. */
    readonly skillTopK?: number;
  };
}

/**
 * The AI workflow (Milestone 2):
 *
 *   Objective -> Planner -> Researcher -> Builder -> Verifier
 *                      (one automatic repair cycle on failure)
 *
 * The planner produces a Zod-validated `AgentPlan`; the plan
 * becomes a `TaskGraph` executed by the existing orchestrator
 * with an enriched agent context (objective, previous results,
 * available tools, model metadata). When the verifier fails,
 * exactly one repair cycle runs: the builder receives the
 * structured failure report, repairs, and the verifier runs
 * again. The loop is bounded by `maxRepairCycles` (default 1),
 * so it can never spin forever.
 */
export class AIWorkflow {
  constructor(private readonly deps: AIWorkflowDeps) {}

  async run(objective: string): Promise<AIWorkflowOutcome> {
    const workflowId = this.deps.ids.runId();
    const startedAt = this.deps.clock.now();
    const phases: AIPhaseOutcome[] = [];
    const runOutcomes: RunOutcome[] = [];
    // Live map of completed task outputs, updated from the
    // synchronous event bus so later tasks observe earlier
    // results through their agent context.
    const results = new Map<TaskId, JsonValue>();
    const activeRuns = new Set<RunId>();
    const maxRepairCycles = this.deps.options?.maxRepairCycles ?? 1;
    let repairs = 0;
    let finalStatus: 'succeeded' | 'failed' = 'failed';

    this.deps.evidence.record({
      runId: workflowId,
      kind: 'workflow.started',
      data: { objective, maxRepairCycles },
    });

    const unsubscribe = this.deps.bus.on('task.succeeded', (event) => {
      if (event.taskId === undefined) return;
      if (!activeRuns.has(event.runId)) return;
      const row = this.deps.tasks.get(event.taskId);
      if (row === null || row.output === undefined) return;
      try {
        results.set(event.taskId, JSON.parse(row.output) as JsonValue);
      } catch {
        // Task output is persisted as canonical JSON; a
        // malformed row is ignored rather than fatal.
      }
    });

    try {
      // ---- Phase 1: Planner ------------------------------------------------
      const planGraph = new TaskGraph();
      planGraph.addTask(
        createTask(this.deps.ids.taskId(), 'plan', 'planner', {
          capability: 'planning',
          input: {
            objective,
            availableTools: this.deps.tools
              .list()
              .map((tool) => `${tool.name}: ${tool.description}`),
          },
        }),
      );
      const planOutcome = await this.runPhase(
        planGraph,
        'ai-planner',
        activeRuns,
        results,
        objective,
      );
      runOutcomes.push(planOutcome);
      this.collectPhases(planOutcome, phases, planOutcome.runId, false);
      if (planOutcome.status !== 'succeeded') {
        throw new OrchestrationError(
          `Planning failed: ${firstError(planOutcome)}`,
        );
      }

      const planTask = planOutcome.tasks[0];
      if (planTask === undefined || planTask.output === undefined) {
        throw new OrchestrationError('Planner produced no output');
      }
      const planValidation = validateStructured(
        AgentPlanSchema,
        planTask.output,
      );
      if (!planValidation.ok) {
        throw new OrchestrationError(
          `Planner output failed AgentPlan validation: ${planValidation.issues.join('; ')}`,
        );
      }
      const plan = planValidation.value;

      this.deps.evidence.record({
        runId: workflowId,
        kind: 'plan.created',
        data: {
          taskCount: plan.tasks.length,
          agents: plan.tasks.map((task) => task.assignedAgent),
          summary: plan.summary,
        },
      });

      // ---- Phase 2: Execute the plan ---------------------------------------
      const main = this.buildGraph(plan, objective);
      const mainOutcome = await this.runPhase(
        main.graph,
        'ai-main',
        activeRuns,
        results,
        objective,
      );
      runOutcomes.push(mainOutcome);
      this.collectPhases(mainOutcome, phases, mainOutcome.runId, false);
      if (mainOutcome.status !== 'succeeded') {
        throw new OrchestrationError(
          `AI workflow execution failed: ${firstError(mainOutcome)}`,
        );
      }

      // ---- Phase 3: Verify, with one bounded repair cycle ------------------
      let verification = this.extractVerification(
        mainOutcome,
        main.planTaskByTaskId,
      );
      let latestVerification: VerificationResult | undefined =
        verification.last;

      while (verification.failed.length > 0 && repairs < maxRepairCycles) {
        repairs += 1;
        this.deps.evidence.record({
          runId: workflowId,
          kind: 'repair.started',
          data: {
            cycle: repairs,
            failedVerifications: verification.failed.map(
              (entry) => entry.result.summary,
            ),
          },
        });

        const repair = this.buildRepairGraph(
          plan,
          objective,
          verification.failed,
        );
        const repairOutcome = await this.runPhase(
          repair.graph,
          `ai-repair-${repairs}`,
          activeRuns,
          results,
          objective,
        );
        runOutcomes.push(repairOutcome);
        this.collectPhases(repairOutcome, phases, repairOutcome.runId, true);
        if (repairOutcome.status !== 'succeeded') {
          throw new OrchestrationError(
            `Repair cycle ${repairs} failed: ${firstError(repairOutcome)}`,
          );
        }

        verification = this.extractVerification(
          repairOutcome,
          repair.planTaskByTaskId,
        );
        latestVerification = verification.last;
        this.deps.evidence.record({
          runId: workflowId,
          kind: 'repair.completed',
          data: {
            cycle: repairs,
            passed: verification.failed.length === 0,
          },
        });
      }

      finalStatus = verification.failed.length === 0 ? 'succeeded' : 'failed';

      return {
        workflowId,
        objective,
        status: finalStatus,
        plan,
        phases,
        verification: latestVerification,
        repairs,
        durationMs: this.deps.clock.now() - startedAt,
        runs: runOutcomes,
      };
    } finally {
      unsubscribe();
      this.deps.evidence.record({
        runId: workflowId,
        kind: 'workflow.outcome',
        data: {
          status: finalStatus,
          repairs,
          phaseCount: phases.length,
          objective,
        },
      });
    }
  }

  /** Start one orchestrator run and track it for result collection. */
  private async runPhase(
    graph: TaskGraph,
    runName: string,
    activeRuns: Set<RunId>,
    results: Map<TaskId, JsonValue>,
    objective: string,
  ): Promise<RunOutcome> {
    const orchestrator = new Orchestrator({
      agents: this.deps.agents,
      tools: this.deps.tools,
      bus: this.deps.bus,
      ids: this.deps.ids,
      clock: this.deps.clock,
      runs: this.deps.runs,
      tasks: this.deps.tasks,
      evidence: this.deps.evidence,
      options: {
        concurrency: this.deps.options?.concurrency ?? 1,
        failFast: true,
        // Enrich the plain agent context with the AI layer's
        // per-run state: objective, previous results, available
        // tools, provider/model metadata, knowledge context (RAG),
        // and skill context.
        agentContextFactory: (base: AgentContext, task) => {
          const knowledgeContext = this.retrieveKnowledge(objective, task);
          const skillContext = this.selectSkillContext(objective, task);
          return {
            ...base,
            objective,
            previousResults: [...results.values()],
            availableTools: this.deps.tools.list().map((tool) => tool.name),
            model: this.deps.llm.model,
            knowledgeContext,
            skillContext,
          };
        },
      },
    });
    const handle = orchestrator.start(graph, runName);
    activeRuns.add(handle.runId);
    return handle.promise;
  }

  /**
   * Retrieve relevant knowledge chunks for a task.
   * Records retrieval evidence (query, chunks, scores, sources).
   */
  private retrieveKnowledge(
    objective: string,
    task: { readonly input?: JsonValue },
  ) {
    if (this.deps.knowledgeStore === undefined) return undefined;

    const taskInput = task.input;
    const taskDescription =
      isJsonObject(taskInput) && typeof taskInput['description'] === 'string'
        ? taskInput['description']
        : objective;

    const query = `${objective} ${taskDescription}`;
    const topK = this.deps.options?.knowledgeTopK ?? 3;
    const retrieval = this.deps.knowledgeStore.retrieve(query, topK);

    // Record retrieval evidence.
    const evidence = buildRetrievalEvidence(query, retrieval.chunks);
    this.deps.evidence.record({
      runId: this.deps.ids.runId(),
      kind: 'knowledge.retrieval',
      data: {
        query: evidence.query,
        chunkIds: [...evidence.chunkIds],
        sources: [...evidence.sources],
        scores: [...evidence.scores],
        totalCandidates: retrieval.totalCandidates,
      },
    });

    return retrieval;
  }

  /**
   * Select relevant skills for a task.
   * Records skill selection evidence.
   */
  private selectSkillContext(
    objective: string,
    task: { readonly input?: JsonValue },
  ) {
    if (this.deps.skills === undefined || this.deps.skills.length === 0) return undefined;

    const taskInput = task.input;
    const taskDescription =
      isJsonObject(taskInput) && typeof taskInput['description'] === 'string'
        ? taskInput['description']
        : objective;

    const query = `${objective} ${taskDescription}`;
    const topK = this.deps.options?.skillTopK ?? 2;
    const selected = selectSkills(this.deps.skills, query, { topK });

    if (selected.length === 0) return undefined;

    // Record skill selection evidence.
    this.deps.evidence.record({
      runId: this.deps.ids.runId(),
      kind: 'skill.selected',
      data: {
        query,
        selectedSkills: selected.map((s) => ({
          skillId: s.skill.id,
          name: s.skill.metadata.name,
          score: s.score,
        })),
      },
    });

    return selected.map((s) => ({
      skillId: s.skill.id,
      name: s.skill.metadata.name,
      instructions: s.skill.instructions,
    }));
  }

  /** Convert a validated plan into an executable task graph. */
  private buildGraph(
    plan: AgentPlan,
    objective: string,
  ): {
    readonly graph: TaskGraph;
    /** Plan task id -> orchestrator task id. */
    readonly idMap: Map<string, TaskId>;
    /** Orchestrator task id -> plan task (for consuming outputs). */
    readonly planTaskByTaskId: Map<TaskId, PlannedTask>;
  } {
    const graph = new TaskGraph();
    const idMap = new Map<string, TaskId>();
    const planTaskByTaskId = new Map<TaskId, PlannedTask>();
    for (const planned of plan.tasks) {
      const taskId = this.deps.ids.taskId();
      idMap.set(planned.id, taskId);
      planTaskByTaskId.set(taskId, planned);
    }
    for (const planned of plan.tasks) {
      const taskId = idMap.get(planned.id);
      if (taskId === undefined) {
        throw new ValidationError(`Plan task '${planned.id}' was not mapped`);
      }
      graph.addTask(
        createTask(taskId, planned.name, planned.assignedAgent, {
          capability: AGENT_CAPABILITIES[planned.assignedAgent],
          dependsOn: planned.dependsOn.map((dep) => {
            const mapped = idMap.get(dep);
            if (mapped === undefined) {
              throw new ValidationError(
                `Plan task '${planned.id}' depends on unknown task '${dep}'`,
              );
            }
            return mapped;
          }),
          input: {
            objective,
            task: {
              id: planned.id,
              name: planned.name,
              description: planned.description,
              expectedOutcome: planned.expectedOutcome,
            },
            cycle: 0,
          },
        }),
      );
    }
    return { graph, idMap, planTaskByTaskId };
  }

  /**
   * Build the repair graph: every builder that (transitively)
   * feeds a failed verifier is re-run with the verifier's
   * structured failure report, followed by the failed
   * verifiers themselves.
   */
  private buildRepairGraph(
    plan: AgentPlan,
    objective: string,
    failed: readonly FailedVerification[],
  ): {
    readonly graph: TaskGraph;
    /** Orchestrator task id -> plan task (for consuming outputs). */
    readonly planTaskByTaskId: Map<TaskId, PlannedTask>;
  } {
    const graph = new TaskGraph();
    const planTaskByTaskId = new Map<TaskId, PlannedTask>();
    const failedVerifierIds = new Set(failed.map((entry) => entry.planned.id));

    // Builders that feed at least one failed verifier.
    const repairIds = new Set<string>(failedVerifierIds);
    for (const entry of failed) {
      for (const dep of transitiveDeps(plan, entry.planned.id)) {
        const task = plan.tasks.find((candidate) => candidate.id === dep);
        if (task !== undefined && task.assignedAgent === 'builder') {
          repairIds.add(dep);
        }
      }
    }

    const idMap = new Map<string, TaskId>();
    for (const id of repairIds) {
      const taskId = this.deps.ids.taskId();
      idMap.set(id, taskId);
      const planned = plan.tasks.find((candidate) => candidate.id === id);
      if (planned !== undefined) {
        planTaskByTaskId.set(taskId, planned);
      }
    }

    for (const planned of plan.tasks) {
      if (!repairIds.has(planned.id)) continue;
      const isVerifier = planned.assignedAgent === 'verifier';
      const failure = isVerifier
        ? undefined
        : (failureFor(planned.id, failed, plan) ?? failed[0]?.result);
      graph.addTask(
        createTask(
          idMap.get(planned.id) as TaskId,
          `${planned.name} (repair)`,
          planned.assignedAgent,
          {
            capability: AGENT_CAPABILITIES[planned.assignedAgent],
            dependsOn: planned.dependsOn
              .filter((dep) => repairIds.has(dep))
              .map((dep) => idMap.get(dep) as TaskId),
            input: {
              objective,
              task: {
                id: planned.id,
                name: planned.name,
                description: planned.description,
                expectedOutcome: planned.expectedOutcome,
              },
              cycle: 1,
              ...(failure !== undefined
                ? { failure: failure as unknown as JsonValue }
                : {}),
            },
          },
        ),
      );
    }
    return { graph, planTaskByTaskId };
  }

  /** Collect display phases from a completed run. */
  private collectPhases(
    outcome: RunOutcome,
    phases: AIPhaseOutcome[],
    runId: RunId,
    isRepair: boolean,
  ): void {
    for (const task of outcome.tasks) {
      let phase: AIPhaseKind;
      let label: string;
      switch (task.agent) {
        case 'planner':
          phase = 'planner';
          label = 'Planner';
          break;
        case 'researcher':
          phase = 'researcher';
          label = 'Researcher';
          break;
        case 'builder':
          phase = isRepair ? 'repair' : 'builder';
          label = isRepair ? 'Repair' : 'Builder';
          break;
        case 'verifier':
          phase = 'verifier';
          label = 'Verifier';
          break;
        default:
          phase = 'agent';
          label = task.agent;
      }

      let verificationPassed: boolean | undefined;
      if (task.agent === 'verifier' && task.output !== undefined) {
        const verdict = validateStructured(
          VerificationResultSchema,
          task.output,
        );
        if (verdict.ok) {
          verificationPassed = verdict.value.passed;
        }
      }

      phases.push({
        phase,
        label,
        agent: task.agent,
        taskName: task.taskName,
        taskId: task.taskId,
        runId,
        status: task.status === 'succeeded' ? 'succeeded' : 'failed',
        summary: phaseSummary(task),
        durationMs: task.durationMs,
        verificationPassed,
      });
    }
  }

  /** Validate every verifier output of a run and bucket the verdicts. */
  private extractVerification(
    outcome: RunOutcome,
    planTaskByTaskId: Map<TaskId, PlannedTask>,
  ): {
    readonly passed: readonly FailedVerification[];
    readonly failed: readonly FailedVerification[];
    readonly last: VerificationResult | undefined;
  } {
    const passed: FailedVerification[] = [];
    const failed: FailedVerification[] = [];
    let last: VerificationResult | undefined;
    for (const task of outcome.tasks) {
      if (task.agent !== 'verifier' || task.output === undefined) continue;
      const verdict = validateStructured(
        VerificationResultSchema,
        task.output,
      );
      if (!verdict.ok) {
        throw new OrchestrationError(
          `Verifier output failed VerificationResult validation: ${verdict.issues.join('; ')}`,
        );
      }
      const planned = planTaskByTaskId.get(task.taskId);
      if (planned === undefined) {
        throw new OrchestrationError(
          `Verifier task '${task.taskId}' is not part of the plan`,
        );
      }
      const entry: FailedVerification = {
        planned,
        task,
        result: verdict.value,
      };
      if (verdict.value.passed) {
        passed.push(entry);
      } else {
        failed.push(entry);
      }
      last = verdict.value;
    }
    return { passed, failed, last };
  }
}

/** All task ids reachable from `taskId` through `dependsOn` (inclusive). */
function transitiveDeps(plan: AgentPlan, taskId: string): Set<string> {
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) return;
    for (const dep of task.dependsOn) {
      visit(dep);
    }
  };
  visit(taskId);
  return visited;
}

/** The first failed verification whose dependency tree contains `builderId`. */
function failureFor(
  builderId: string,
  failed: readonly FailedVerification[],
  plan: AgentPlan,
): VerificationResult | undefined {
  for (const entry of failed) {
    if (transitiveDeps(plan, entry.planned.id).has(builderId)) {
      return entry.result;
    }
  }
  return undefined;
}

function firstError(outcome: RunOutcome): string {
  const failed = outcome.tasks.find((task) => task.status === 'failed');
  return failed?.error ?? 'unknown error';
}

function phaseSummary(task: TaskOutcome): string {
  if (task.output !== undefined && isJsonObject(task.output)) {
    const summary = task.output['summary'];
    if (typeof summary === 'string' && summary.length > 0) {
      return summary;
    }
  }
  return task.error ?? task.taskName;
}
