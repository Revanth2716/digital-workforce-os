/**
 * Composition root. Wires the modules together with explicit dependencies
 * and exposes the public API of the application.
 */
export * from './core/errors.js';
export * from './core/json.js';
export * from './core/result.js';
export * from './core/status.js';
export * from './core/types.js';
export * from './graph/task-graph.js';
export * from './agents/agent.js';
export * from './agents/agent-registry.js';
export * from './agents/deterministic-agent.js';
export * from './agents/schemas.js';
export * from './agents/agent-support.js';
export * from './agents/tool-caller.js';
export * from './agents/planner-agent.js';
export * from './agents/researcher-agent.js';
export * from './agents/builder-agent.js';
export * from './agents/verifier-agent.js';
export * from './tools/tool.js';
export * from './tools/tool-registry.js';
export * from './tools/builtin-tools.js';
export * from './events/events.js';
export * from './events/event-bus.js';
export * from './events/evidence.js';
export * from './persistence/database.js';
export * from './persistence/run-repository.js';
export * from './persistence/task-repository.js';
export * from './persistence/event-repository.js';
export * from './providers/provider.js';
export * from './providers/random.js';
export * from './providers/deterministic-provider.js';
export * from './providers/llm-provider.js';
export * from './providers/json-schema-generate.js';
export * from './providers/deterministic-llm-provider.js';
export * from './providers/openai-compatible-provider.js';
export * from './orchestrator/orchestrator.js';
export * from './orchestrator/ai-workflow.js';
export * from './orchestrator/ai-demo.js';
export * from './orchestrator/safety-demo.js';
export * from './knowledge/index.js';
export * from './skills/index.js';
export * from './mcp/index.js';
export * from './evaluation/index.js';
export * from './policy/index.js';
export * from './security/index.js';
export * from './approval/index.js';
export * from './tools/policy-gate.js';
export * from './observability/index.js';
export * from './application/index.js';
export * from './persistence/observability-repository.js';
export * from './api/index.js';

import { AppDatabase } from './persistence/database.js';
import { RunRepository } from './persistence/run-repository.js';
import { TaskRepository } from './persistence/task-repository.js';
import { EventRepository } from './persistence/event-repository.js';
import { TypedEventBus } from './events/event-bus.js';
import { EvidenceLog } from './events/evidence.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { DeterministicAgent } from './agents/deterministic-agent.js';
import { PlannerAgent } from './agents/planner-agent.js';
import { ResearcherAgent } from './agents/researcher-agent.js';
import { BuilderAgent } from './agents/builder-agent.js';
import { VerifierAgent } from './agents/verifier-agent.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { CalculatorTool, WordCountTool } from './tools/builtin-tools.js';
import { DeterministicProvider } from './providers/deterministic-provider.js';
import {
  DeterministicLLMProvider,
} from './providers/deterministic-llm-provider.js';
import type { LLMProvider } from './providers/llm-provider.js';
import { AIWorkflow } from './orchestrator/ai-workflow.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Clock, IdGenerator, RandomIdGenerator, SystemClock } from './core/types.js';
import type { JsonValue } from './core/json.js';
import { KnowledgeStore } from './knowledge/knowledge-store.js';
import { loadSkills } from './skills/skill-loader.js';
import type { Skill } from './skills/skill.js';
import { DefaultPolicyGate } from './tools/policy-gate.js';
import { ApprovalManager } from './approval/approval-manager.js';
import type { ApprovalHandler } from './approval/approval-manager.js';
import type { PolicyEngine } from './policy/policy-engine.js';
import { ObservabilityRepository } from './persistence/observability-repository.js';
import { LocalTracer } from './observability/tracer.js';
import { instrument } from './observability/instrumentation.js';
import type { InstrumentationHandle } from './observability/instrumentation.js';
import { RunService } from './application/run-service.js';
import { WorkflowService } from './application/workflow-service.js';
import { ApprovalService } from './application/approval-service.js';
import { EvaluationService } from './application/evaluation-service.js';

/** Configuration for the default composition. */
export interface CompositionConfig {
  /** SQLite file path. Defaults to an in-memory database. */
  readonly dbPath?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly retryBaseDelayMs?: number;
  /** Default seed for the deterministic provider. */
  readonly seed?: number;
  /**
   * Optional LLM provider override (Milestone 2). Defaults to
   * the offline deterministic LLM provider — no network, no
   * API key. Pass an `OpenAICompatibleProvider` (configured
   * explicitly) to use a real model.
   */
  readonly llm?: LLMProvider;
  /**
   * Scripted structured responses for the default
   * deterministic LLM provider, keyed by intent.
   * Used by demos and tests for fully controlled
   * offline scenarios.
   */
  readonly llmResponses?: Readonly<Record<string, JsonValue>>;
  /** Maximum automatic AI workflow repair cycles. Defaults to 1. */
  readonly maxRepairCycles?: number;
  /**
   * Milestone 3: knowledge store for RAG retrieval. If not
   * provided, a default store is created and pre-populated
   * with project documentation.
   */
  readonly knowledgeStore?: KnowledgeStore;
  /**
   * Milestone 3: skills directory path. If provided, skills
   * are loaded from this directory and made available to the
   * AI workflow for selection.
   */
  readonly skillsDir?: string;
  /** Milestone 3: number of knowledge chunks to retrieve. Defaults to 3. */
  readonly knowledgeTopK?: number;
  /** Milestone 3: number of skills to select. Defaults to 2. */
  readonly skillTopK?: number;
  /**
   * Milestone 4: policy engine. When provided, every tool call
   * is evaluated by the capability policy before execution —
   * including calls made by agents. Defaults to undefined,
   * which leaves the registry unguarded (Milestone 1-3
   * behaviour).
   */
  readonly policy?: PolicyEngine;
  /** Milestone 4: approval manager for REQUIRE_APPROVAL decisions. */
  readonly approval?: ApprovalManager;
  /** Milestone 4: convenience handler wired into a default approval manager. */
  readonly approvalHandler?: ApprovalHandler;
  /** Milestone 4: run prompt-injection checks on tool input/output. Defaults to true. */
  readonly checkInjection?: boolean;
}

/** All wired modules, ready to use. */
export interface Composition {
  readonly db: AppDatabase;
  readonly bus: TypedEventBus;
  readonly orchestrator: Orchestrator;
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  /** Milestone 1 text provider. */
  readonly provider: DeterministicProvider;
  /** Milestone 2 LLM provider (structured generation). */
  readonly llm: LLMProvider;
  /** Milestone 2 AI workflow (planner -> specialists -> verifier). */
  readonly ai: AIWorkflow;
  /** Milestone 3: knowledge store for RAG retrieval. */
  readonly knowledgeStore: KnowledgeStore;
  /** Milestone 3: loaded skills. */
  readonly skills: readonly Skill[];
  readonly evidence: EvidenceLog;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;
  /** Milestone 5-A: local observability. */
  readonly observability: ObservabilityRepository;
  /** Milestone 5-A: in-process tracer. */
  readonly tracer: LocalTracer;
  /** Milestone 5-A: instrumentation handle (dispose to detach). */
  readonly instrumentation: InstrumentationHandle;
  /** Milestone 5-A: read-side application services. */
  readonly runService: RunService;
  readonly workflowService: WorkflowService;
  readonly approvalService: ApprovalService;
  readonly evaluationService: EvaluationService;
  close(): void;
}

/**
 * Build the default composition. The event bus persists every event to
 * SQLite (via `onAny`) before any in-memory subscriber sees it, so the
 * event log is always at least as durable as the rest of the system state.
 */
export function createComposition(config: CompositionConfig = {}): Composition {
  const db = new AppDatabase(config.dbPath ?? ':memory:');
  const bus = new TypedEventBus();
  const ids = config.ids ?? new RandomIdGenerator();
  const clock = config.clock ?? new SystemClock();

  const runs = new RunRepository(db.db);
  const tasks = new TaskRepository(db.db);
  const events = new EventRepository(db.db);
  bus.onAny((event) => {
    events.append(event);
  });

  const provider = new DeterministicProvider({ seed: config.seed });
  const agent = new DeterministicAgent(provider);

  // Milestone 2: the LLM provider layer. The default is the
  // offline deterministic adapter (zero network); an explicitly
  // configured provider (e.g. OpenAICompatibleProvider) can be
  // injected. The deterministic provider remains fully functional.
  const llm: LLMProvider =
    config.llm ??
    new DeterministicLLMProvider({
      seed: config.seed,
      responses: config.llmResponses,
    });

  // Milestone 4: when a policy engine is configured, a gate is
  // enforced inside ToolRegistry.execute(), so every tool call
  // issued by an agent passes schema validation -> policy
  // evaluation -> injection check -> approval -> execution.
  // With no policy engine the registry is unguarded and
  // Milestone 1-3 behaviour is preserved exactly.
  const policyGate =
    config.policy !== undefined
      ? new DefaultPolicyGate({
          policyEngine: config.policy,
          approvalManager:
            config.approval ?? new ApprovalManager(config.approvalHandler),
          checkInjection: config.checkInjection ?? true,
        })
      : undefined;
  const tools = new ToolRegistry(policyGate !== undefined ? { gate: policyGate } : {});
  tools.register(new CalculatorTool());
  tools.register(new WordCountTool());

  const agents = new AgentRegistry();
  agents.register(agent);
  // AI specialist agents. The planner verifies plans against
  // this registry at execution time, so registration order
  // does not matter.
  agents.register(new PlannerAgent(llm, agents));
  agents.register(new ResearcherAgent(llm, tools));
  agents.register(new BuilderAgent(llm, tools));
  agents.register(new VerifierAgent(llm));

  const evidence = new EvidenceLog(bus, ids, clock);

  const orchestrator = new Orchestrator({
    agents,
    tools,
    bus,
    ids,
    clock,
    runs,
    tasks,
    evidence,
    options: {
      concurrency: config.concurrency,
      failFast: config.failFast,
      retryBaseDelayMs: config.retryBaseDelayMs,
    },
  });

  // Milestone 3: knowledge store and skills.
  const knowledgeStore = config.knowledgeStore ?? new KnowledgeStore();
  const skills = config.skillsDir !== undefined ? loadSkills(config.skillsDir) : [];

  const ai = new AIWorkflow({
    agents,
    tools,
    bus,
    ids,
    clock,
    runs,
    tasks,
    evidence,
    llm,
    knowledgeStore,
    skills,
    options: {
      concurrency: config.concurrency,
      maxRepairCycles: config.maxRepairCycles,
      knowledgeTopK: config.knowledgeTopK,
      skillTopK: config.skillTopK,
    },
  });

  // ---- Milestone 5-A: observability + application services ----
  // Instrumentation only observes signals the engine already emits
  // (typed events and the evidence log), so no orchestration logic
  // is modified or duplicated.
  const observability = new ObservabilityRepository(db.db);
  const tracer = new LocalTracer(clock, observability);
  const instrumentation = instrument({
    bus,
    tracer,
    clock,
    tools,
    provider: llm.name,
    model: llm.model.name,
  });

  const approvalService = new ApprovalService({
    approvals: config.approval ?? new ApprovalManager(config.approvalHandler),
    clock,
  });

  const runService = new RunService({
    runs,
    tasks,
    events,
    observability,
    // Supplied as a callback so RunService stays independent of
    // the approval service.
    pendingApprovalCount: () => approvalService.listPending().length,
  });
  const workflowService = new WorkflowService({
    ai,
    orchestrator,
    runs,
    ids,
    tracer,
    maxRepairCycles: config.maxRepairCycles,
  });
  const evaluationService = new EvaluationService({ runService });

  return {
    db,
    bus,
    orchestrator,
    agents,
    tools,
    provider,
    llm,
    ai,
    knowledgeStore,
    skills,
    evidence,
    runs,
    tasks,
    events,
    observability,
    tracer,
    instrumentation,
    runService,
    workflowService,
    approvalService,
    evaluationService,
    close: () => {
      instrumentation.dispose();
      db.close();
    },
  };
}
