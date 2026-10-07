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
export * from './orchestrator/orchestrator.js';

import { AppDatabase } from './persistence/database.js';
import { RunRepository } from './persistence/run-repository.js';
import { TaskRepository } from './persistence/task-repository.js';
import { EventRepository } from './persistence/event-repository.js';
import { TypedEventBus } from './events/event-bus.js';
import { EvidenceLog } from './events/evidence.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { DeterministicAgent } from './agents/deterministic-agent.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { CalculatorTool, WordCountTool } from './tools/builtin-tools.js';
import { DeterministicProvider } from './providers/deterministic-provider.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Clock, IdGenerator, RandomIdGenerator, SystemClock } from './core/types.js';

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
}

/** All wired modules, ready to use. */
export interface Composition {
  readonly db: AppDatabase;
  readonly bus: TypedEventBus;
  readonly orchestrator: Orchestrator;
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly provider: DeterministicProvider;
  readonly evidence: EvidenceLog;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;
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

  const agents = new AgentRegistry();
  agents.register(agent);

  const tools = new ToolRegistry();
  tools.register(new CalculatorTool());
  tools.register(new WordCountTool());

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

  return {
    db,
    bus,
    orchestrator,
    agents,
    tools,
    provider,
    evidence,
    runs,
    tasks,
    events,
    close: () => db.close(),
  };
}
