# Digital Workforce OS — Architecture

Milestone 1 established the foundation of a governed
multi-agent workflow system: a deterministic, fully
local, testable core with SQLite-backed auditability.
Milestone 2 turned that engine into a real AI-agent
execution layer: an LLM provider abstraction, Zod
structured outputs, a planner, specialist agents
(researcher / builder / verifier), structured tool
calling, and a bounded repair cycle. Everything still
runs offline with zero API keys and zero paid
services; the deterministic provider remains the
default.

## Module boundaries

```
src/
  core/          Domain primitives shared by every module:
                  branded IDs (TaskId, RunId, EventId,
                  EvidenceId), IdGenerator, Clock
                  abstraction, domain errors with stable
                  codes (incl. StructuredOutputError),
                  Result type, task/run status types,
                  canonical JSON + SHA-256 hashing.
  graph/         TaskGraph and TaskDefinition. Pure data +
                  pure algorithms: dependency queries,
                  structural validation, DFS cycle
                  detection, deterministic topological
                  ordering (Kahn's algorithm with an
                  insertion-order tiebreak), execution
                  waves.
  orchestrator/  Orchestrator. Owns the task lifecycle, the
                  dependency-aware ready queue, the
                  concurrency limit, exponential-backoff
                  retries, per-task timeouts, cooperative
                  cancellation, and an optional
                  agent-context enrichment hook.
                  AIWorkflow: the Milestone 2
                  objective -> planner -> specialists ->
                  verifier pipeline with one bounded
                  repair cycle, built on the plain
                  Orchestrator.
  agents/        Agent interface, AgentContext (now with
                  objective, previous results, available
                  tools and model metadata), AgentRegistry,
                  the DeterministicAgent, the Zod
                  structured schemas, the structured
                  tool-calling flow (ToolCaller), and the
                  AI specialists: PlannerAgent,
                  ResearcherAgent, BuilderAgent,
                  VerifierAgent.
  tools/         Tool interface (with an optional
                  readOnly flag), JSON-schema-lite input
                  validation, ToolRegistry, and pure
                  builtin tools (calculator, word count).
  events/        Strongly typed event union, TypedEventBus
                  (synchronous dispatch), and the
                  append-only EvidenceLog with
                  content-addressed hashes.
  persistence/   AppDatabase (better-sqlite3, WAL, foreign
                  keys, transactional migrations) and
                  append-only repositories for runs, tasks
                  and events.
  providers/     Provider interface and the
                  DeterministicProvider (seeded PRNG, no
                  network); the LLMProvider abstraction
                  (text + structured generation, model
                  metadata); the DeterministicLLMProvider
                  adapter (offline, scripted scenarios);
                  and the optional OpenAICompatibleProvider
                  (explicitly configured, never mandatory).
  index.ts       Composition root: createComposition() wires
                  all modules together and is the only
                  place where concrete implementations meet.
  cli.ts         Demo CLI: the M1 graph demo (research ->
                  implementation -> verification) and the
                  M2 AI workflow demo (--ai).
```

### Dependency rules

Dependencies point inward:

- `core` imports nothing but `node:crypto`.
- `graph`, `events`, `tools`, `providers` depend only on
  `core` (and `zod` in `providers`/`agents` for
  structured-output contracts).
- `agents` depends on `core`, `tools`, `events`,
  `providers` — via interfaces only.
- `orchestrator` depends on `core`, `graph`, `agents`,
  `events`, `persistence`, `tools`, `providers` — again
  via interfaces and repository classes, never on
  concrete agents or providers.
- `persistence` depends on `core`, `graph` (for the task
  shape) and `events` (for the event shape).
- `index.ts` (composition root) is the only module
  allowed to import concrete implementations of
  everything.

## Dependency inversion

Every cross-module seam is an interface owned by the
consumer:

| Seam | Interface | M1 implementation | M2 implementation | Swappable later |
| --- | --- | --- | --- | --- |
| Reasoning (text) | `Provider` | `DeterministicProvider` | — | Any LLM API |
| Reasoning (LLM) | `LLMProvider` | — | `DeterministicLLMProvider` | `OpenAICompatibleProvider`, local models |
| Work execution | `Agent` | `DeterministicAgent` | `PlannerAgent`, `ResearcherAgent`, `BuilderAgent`, `VerifierAgent` | LLM-backed agents, code agents |
| Capabilities | `Tool` | `CalculatorTool`, `WordCountTool` | (same, now with `readOnly`) | Filesystem, search, HTTP tools |
| Time | `Clock` | `SystemClock` | `FakeClock` (tests) | — |
| Identity | `IdGenerator` | `RandomIdGenerator` | `DeterministicIdGenerator` (tests) | — |

The orchestrator never imports an agent or provider; it
receives an `AgentRegistry`, a `ToolRegistry`, repositories,
an event bus, an `IdGenerator` and a `Clock`. Agents never
import tools; they receive a `ToolRegistry` through
`AgentContext`. The AI layer adds one optional orchestrator
seam — `agentContextFactory` — which enriches the plain
agent context with the AI layer's per-run state (objective,
previous results, available tools, model metadata) without
changing any Milestone 1 behaviour.

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
request hash. It derives its PRNG seed from an FNV-1a hash of
the prompt combined with the request seed, then selects sentences from
a fixed vocabulary using the Mulberry32 PRNG. No network, no API
key, no nondeterminism.

`DeterministicAgent` seeds each completion from its task ID, so
identical tasks produce identical outputs across runs — which is
what makes evidence hashes reproducible test fixtures. It also
demonstrates tool delegation driven by task input
(`{ tool, args }`) and records evidence for both tool invocations
and completions.

## LLM provider layer (Milestone 2)

`LLMProvider` extends the Milestone 1 `Provider` seam with
what an AI agent layer needs:

- **text generation** — `complete(request)` (inherited),
- **structured generation** —
  `generateStructured({ prompt, schema, intent })` returns a
  `StructuredCompletion` whose `value` has already been
  validated against the caller's Zod schema,
- **model metadata** — `model: ModelInfo` (provider, model
  name, version, capabilities, token limits),
- **token/usage metadata** — `usage` on every completion,
- **timeout/error handling** — providers normalise failures
  into `ProviderError`, `TimeoutError` and
  `StructuredOutputError` (a stable `structured_output`
  domain code with the validation issues attached).

Two implementations:

- `DeterministicLLMProvider` — the default. An adapter
  over the M1 `DeterministicProvider`: `complete()`
  delegates unchanged; `generateStructured()` produces
  schema-validated output fully offline, either from a
  scripted response (keyed by `intent`, for controlled
  demos/tests) or by deterministically instantiating the
  Zod schema's JSON-Schema form with the seeded PRNG.
  Scripted responses are validated exactly like generated
  ones — an invalid script fails loudly.
- `OpenAICompatibleProvider` — optional. Talks to any
  OpenAI-compatible `/chat/completions` endpoint,
  including the structured-outputs API
  (`response_format: json_schema`). It is opt-in: it
  refuses to construct without an explicit base URL
  (option or `OPENAI_BASE_URL`), never hard-codes
  credentials (API key from options or
  `OPENAI_API_KEY`, and some endpoints need none),
  bounds every request with a wall-clock timeout, and
  accepts an injected `fetch` so tests run with zero
  network.

Provider neutrality: the composition only creates the
OpenAI-compatible provider when explicitly configured.
Agents and the workflow depend on the `LLMProvider`
interface, so swapping providers changes nothing else —
and the deterministic provider guarantees the test suite
never depends on network or model availability.

## Structured outputs (Milestone 2)

Zod schemas define every model-generated artifact:
`AgentPlan`, `PlannedTask`, `AgentResult`,
`ToolCallRequest`, `ToolCallResult`, `VerificationResult`
(plus `ResearchOutput`/`ResearchResult` for the
researcher). Validation happens in three layers:

1. **Provider boundary** — `generateStructured` parses
   and validates the model output before it resolves;
   violations throw `StructuredOutputError` with the
   exact issues.
2. **Agent boundary** — agents validate their assembled
   results (model output + tool evidence) before
   returning them to the orchestrator.
3. **Workflow boundary** — the AI workflow re-validates
   task outputs (plans, verification verdicts) before
   consuming them.

## Agent roles (Milestone 2)

| Agent | Capability | Structured output | Tools |
| --- | --- | --- | --- |
| `PlannerAgent` | `planning` | `AgentPlan` | none (verifies the plan against the registries) |
| `ResearcherAgent` | `research` | `ResearchOutput` → `ResearchResult` | read-only tools only |
| `BuilderAgent` | `implementation` | `BuilderOutput` → `AgentResult` | any registered tool |
| `VerifierAgent` | `verification` | `VerificationResult` | none |

The planner cross-checks its plan against the live
`AgentRegistry` and `ToolRegistry`: unknown agents,
unknown dependencies, duplicate task ids and dependency
cycles are hard errors; unknown tools are recorded as
warnings in the evidence log.

## Agent context (Milestone 2)

`AgentContext` carries the AI layer's per-run state as
immutable snapshots — no global mutable state:

- `objective` — the user objective,
- `runId`, `taskId`, `attempt` (unchanged from M1),
- `previousResults` — outputs of already-completed
  tasks, in completion order,
- `evidence` — the append-only evidence log (unchanged),
- `availableTools` — registered tool names,
- `model` — provider/model metadata.

The orchestrator's optional `agentContextFactory` hook
populates these fields; the AI workflow owns the state
per run and feeds it through the synchronous event bus,
so a task's context always observes its dependencies'
outputs.

## Tool execution flow (Milestone 2)

```
Agent -> ToolCallRequest -> ToolRegistry
     -> input validation -> execute
     -> ToolCallResult -> evidence/event
```

`ToolCaller` wraps the existing `ToolRegistry`:

1. The agent's structured output carries zero or more
   `ToolCallRequest` objects (id, tool, arguments).
2. `ToolCaller` records a `tool.call` evidence record.
3. The registry validates the arguments against the
   tool's declared input schema.
4. The tool executes.
5. A `ToolCallResult` (id, tool, ok, output | error,
   durationMs) is returned and a `tool.result` evidence
   record is written.

Tool failures — unknown tool, schema violations,
execution errors, or a non-read-only tool invoked by
the read-only researcher — come back as `ok: false`
results, never as thrown errors, so agents can report
them as evidence. The researcher's `ToolCaller` runs
with `readOnlyOnly`: it only invokes tools explicitly
marked `readOnly` (both builtin tools are pure and
marked read-only).

## The repair loop (Milestone 2)

`AIWorkflow` realises the pipeline
`Objective -> Planner -> Researcher -> Builder ->
Verifier` on top of the existing orchestrator:

1. The planner runs as a single-task orchestrator run;
   its validated `AgentPlan` is converted into a
   `TaskGraph` (plan task ids are remapped to
   orchestrator task ids, dependencies preserved).
2. The plan graph executes through the orchestrator
   with the enriched agent context.
3. Every verifier output is validated and bucketed by
   `passed`.
4. If any verification failed and the repair budget
   (`maxRepairCycles`, default 1) remains, exactly one
   repair cycle runs: every builder that feeds a failed
   verifier is re-executed with the verifier's
   structured failure report in its task input (the
   builder switches to the `build:repair` intent),
   followed by the failed verifiers (cycle 1,
   `verify:1` intent).
5. The loop is bounded: after one repair the workflow
   ends — `SUCCESS` if verification now passes,
   `FAILED` otherwise. There is no path back into the
   loop, so an infinite repair loop is impossible.

## Evidence-aware execution (Milestone 2)

The append-only evidence log records, per run:

- `workflow.started` / `workflow.outcome` /
  `plan.created` / `repair.started` / `repair.completed`
  (workflow scope),
- `agent.start` / `agent.end` (agent lifecycle),
- `model.call` (provider, model, intent, token usage,
  request hash, previous-result count),
- `structured.validation` (schema, intent, ok, issues),
- `tool.call` / `tool.result` (call id, tool, arguments,
  output or error, duration),
- `verification` (passed, score, issue counts, cycle),
- `plan.warnings` (non-fatal plan verification notes).

Because the bus dispatches synchronously and the event
repository subscribes via `onAny`, every one of these
records is durable in SQLite before the emitting agent
continues.

## Out of scope (deliberately)

RAG, MCP integration, skills, React dashboard, GitHub
automation, OpenTelemetry and cloud deployment belong
to later milestones. Autonomous destructive shell
execution and Kubernetes infrastructure are likewise
deliberately excluded.
