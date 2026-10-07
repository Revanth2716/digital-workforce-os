# Digital Workforce OS — Milestone 1 Architecture

Milestone 1 establishes the foundation of a governed multi-agent
workflow system: a deterministic, fully local, testable core with
SQLite-backed auditability. Everything in this milestone runs
offline with zero API keys and zero paid services.

## Module boundaries

```
src/
  core/          Domain primitives shared by every module:
                 branded IDs (TaskId, RunId, EventId, EvidenceId),
                 IdGenerator, Clock abstraction, domain errors with
                 stable codes, Result type, task/run status types,
                 canonical JSON + SHA-256 hashing.
  graph/         TaskGraph and TaskDefinition. Pure data + pure
                 algorithms: dependency queries, structural
                 validation, DFS cycle detection, deterministic
                 topological ordering (Kahn's algorithm with an
                 insertion-order tiebreak), execution waves.
  orchestrator/  Orchestrator. Owns the task lifecycle, the
                 dependency-aware ready queue, the concurrency
                 limit, exponential-backoff retries, per-task
                 timeouts, and cooperative cancellation.
  agents/        Agent interface, AgentContext, AgentRegistry and
                 the DeterministicAgent implementation.
  tools/         Tool interface, JSON-schema-lite input validation,
                 ToolRegistry, and pure builtin tools
                 (calculator, word count).
  events/        Strongly typed event union, TypedEventBus
                 (synchronous dispatch), and the append-only
                 EvidenceLog with content-addressed hashes.
  persistence/   AppDatabase (better-sqlite3, WAL, foreign keys,
                 transactional migrations) and append-only
                 repositories for runs, tasks and events.
  providers/     Provider interface and the DeterministicProvider
                 (seeded PRNG, no network).
  index.ts       Composition root: createComposition() wires all
                 modules together and is the only place where
                 concrete implementations meet.
  cli.ts         Demo CLI (research -> implementation -> verification).
```

### Dependency rules

Dependencies point inward:

- `core` imports nothing but `node:crypto` / `node:aborting` polyfills.
- `graph`, `events`, `tools`, `providers` depend only on `core`.
- `agents` depends on `core`, `tools`, `events`, `providers` —
  via interfaces only.
- `orchestrator` depends on `core`, `graph`, `agents`, `events`,
  `persistence`, `tools` — again via interfaces and repository
  classes, never on concrete agents or providers.
- `persistence` depends on `core`, `graph` (for the task shape)
  and `events` (for the event shape).
- `index.ts` (composition root) is the only module allowed to
  import concrete implementations of everything.

## Dependency inversion

Every cross-module seam is an interface owned by the consumer:

| Seam | Interface | M1 implementation | Swappable later |
| --- | --- | --- | --- |
| Reasoning | `Provider` | `DeterministicProvider` | Any LLM provider (OpenCode, local models) |
| Work execution | `Agent` | `DeterministicAgent` | LLM-backed agents, code agents |
| Capabilities | `Tool` | `CalculatorTool`, `WordCountTool` | Filesystem, search, HTTP tools |
| Time | `Clock` | `SystemClock` | `FakeClock` (tests) |
| Identity | `IdGenerator` | `RandomIdGenerator` | `DeterministicIdGenerator` (tests) |

The orchestrator never imports an agent or provider; it receives
an `AgentRegistry`, a `ToolRegistry`, repositories, an event bus,
an `IdGenerator` and a `Clock`. Agents never import tools; they
receive a `ToolRegistry` through `AgentContext`. This is what
makes Milestone 2+ integration (real LLM providers, MCP tools)
possible without touching the orchestrator.

## Execution lifecycle

A task moves through:

```
pending -> ready -> running -> succeeded
                              -> failed -> (retry) -> running
                              -> cancelled
                              -> skipped   (dependency failed, continue mode)
```

- **pending** — created with the run, dependencies not yet met.
- **ready** — all dependencies reached a terminal state; the task
  is on the ready queue.
- **running** — an attempt is in flight (`task.started` emitted,
  attempt counter persisted).
- **succeeded** — agent returned; output and summary persisted.
- **failed** — final attempt exhausted; error persisted.
- **cancelled** — run aborted by the user, or fail-fast stopped
  the world.
- **skipped** — a dependency failed in continue mode
  (`failFast: false`).

The scheduler loop:

1. Seed the ready queue with zero-indegree tasks (sorted by
   insertion order).
2. Dispatch while `running < concurrency`, always taking the
   earliest-inserted ready task.
3. `await Promise.race` on running tasks; when one settles, wake
   its dependents (decrement in-degree; at zero, mark ready).
4. On failure: fail-fast aborts the run (running agents observe
   the `AbortSignal`, everything else is cancelled); continue mode
   skips all transitive dependents and keeps going.
5. Finalize: any task still pending/ready is cancelled, the run
   row is updated, and `run.completed` / `run.failed` /
   `run.cancelled` is emitted.

With `concurrency: 1` (the default) execution order equals the
deterministic topological order of the graph. Dispatch order is
always deterministic; with higher concurrency, interleaving of
concurrent tasks is timing-dependent.

Retries use exponential backoff (`retryBaseDelayMs * 2^(attempt-1)`)
and are persisted as `task.retried` events. Per-task `timeoutMs`
races the agent execution against the injected clock.

## Task graph

- `TaskGraph.addTask` enforces structural constraints eagerly:
  unique IDs, non-empty names/agents, non-negative retries,
  positive timeouts, no self-dependency, no duplicate edges.
- `validate()` checks cross-references (unknown dependencies) and
  runs DFS cycle detection, reporting the exact cycle path.
- `topologicalOrder()` is Kahn's algorithm; ties are broken by
  insertion order so the same construction sequence always
  produces the same schedule.
- `levels()` groups tasks into waves for visualization.

## Events and evidence

`WorkflowEvent` is a discriminated union over 12 event types with
per-type typed payloads. `TypedEventBus` dispatches synchronously:
an event is fully handled (including persistence, which subscribes
via `onAny`) before the emitter continues, so ordering is
deterministic and the event log is always at least as durable as
the rest of the system state.

`EvidenceLog.record()` creates an immutable evidence record whose
`hash` is the SHA-256 of the canonical JSON of the record
excluding the hash itself. Records are emitted as
`evidence.recorded` events and persisted in the append-only event
table — they can never be updated or deleted.

## Persistence

SQLite via `better-sqlite3`:

- `PRAGMA journal_mode = WAL`, `foreign_keys = ON`,
  `synchronous = NORMAL`.
- Versioned migrations applied in transactions
  (`schema_migrations` table; `migrations/0001_init.sql`).
- Tables: `runs`, `tasks` (full task definition + input + output
  stored as canonical JSON), `events` (append-only, autoincrement
  sequence, JSON payloads).
- Repositories expose only intent-revealing operations; the event
  repository has no update or delete methods by design.

## Deterministic provider

`DeterministicProvider` is a fully offline "model": the same
prompt + seed always produces the same text, token counts and
request hash. It derives its PRNG seed from an FNV-1a hash of the
prompt combined with the request seed, then selects sentences from
a fixed vocabulary using the Mulberry32 PRNG. No network, no API
key, no nondeterminism.

`DeterministicAgent` seeds each completion from its task ID, so
identical tasks produce identical outputs across runs — which is
what makes evidence hashes reproducible test fixtures. It also
demonstrates tool delegation driven by task input
(`{ tool, args }`) and records evidence for both tool invocations
and completions.

## Future LLM-provider integration (Milestone 2+)

The seams are already in place:

1. Implement `Provider` (`complete(request) => Promise<Completion>`)
   for the target model API. For OpenCode's Ling models, the
   provider would call the local OpenCode gateway — no API key,
   no cost.
2. Implement `Agent` on top of it (prompt construction, tool
   calling loop, output parsing) and register it under a new name.
3. Tasks select agents by name and optional capability, so the
   orchestrator, graph, persistence and event systems are
   untouched.

The deterministic provider remains as the default for tests, CI
and offline demos, guaranteeing the test suite never depends on
network availability or model availability.

## Out of scope for Milestone 1 (deliberately)

React dashboard, RAG, MCP integration, GitHub automation, real
LLM API calls, autonomous destructive shell execution, Kubernetes
and cloud infrastructure. All belong to later milestones.
