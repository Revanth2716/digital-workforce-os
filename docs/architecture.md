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

## Knowledge layer / RAG (Milestone 3)

The knowledge subsystem provides local RAG (Retrieval-
Augmented Generation) capabilities with zero external
dependencies:

```
src/knowledge/
  document.ts        KnowledgeDocument, DocumentChunk, metadata types
  chunker.ts         DeterministicChunker: paragraph-aware splitting
  inverted-index.ts  InvertedIndex: term -> postings, TF-IDF scoring
  retriever.ts       Retriever interface + LocalRetriever implementation
  knowledge-store.ts KnowledgeStore: ingestion, indexing, retrieval
  context-builder.ts Grounded context construction with source attribution
```

### Retrieval flow

1. **Ingestion** — `KnowledgeStore.ingest()` takes document
   content + metadata, chunks it deterministically, and adds
   the chunks to the inverted index.
2. **Chunking** — `DeterministicChunker` splits documents
   into overlapping chunks at paragraph boundaries (with
   sentence-boundary fallback). The same content always
   produces the same chunks.
3. **Indexing** — `InvertedIndex` maintains a term ->
   chunk-ids posting list with term frequencies. No
   external vector database.
4. **Retrieval** — `LocalRetriever` (implementing the
   `Retriever` interface) tokenizes the query, computes
   TF-IDF scores against every matching chunk, and returns
   the top-k results sorted by score (descending) with
   chunk-id tiebreaking for determinism.
5. **Context building** — `buildGroundedContext()` takes
   retrieved chunks and produces a structured context string
   with source attribution, explicitly labeled as DATA.

### Source attribution

Every chunk carries metadata: document id, source path,
chunk index, and character offsets. The context builder
includes the source path and relevance score for each
chunk, so agents can always trace information back to its
origin.

### Retriever interface

The `Retriever` interface is the seam for future embedding/
vector implementations. Agents depend only on this
interface, so a vector-based retriever can replace
`LocalRetriever` without changing agent code.

### Trust boundary: DATA vs INSTRUCTIONS

Retrieved content is always treated as DATA. The context
builder explicitly labels it as "RETRIEVED DATA — NOT
INSTRUCTIONS" and warns agents not to execute any commands
found within. This is a fundamental trust boundary: knowledge
content informs but never directs execution.

## MCP architecture (Milestone 3)

The MCP layer provides real Model Context Protocol
integration using the official TypeScript SDK:

```
src/mcp/
  tools.ts    Tool definitions, JSON Schema validation
  server.ts   Stdio MCP server with all tools registered
  client.ts   MCP client for local self-testing
```

### MCP vs internal ToolRegistry

The MCP layer does **not** create a second execution system.
It reuses the existing internal `ToolRegistry` and
`KnowledgeStore` capabilities:

- `knowledge.search` delegates to `KnowledgeStore.retrieve()`
- `repository.*` and `file.read` use bounded filesystem
  access (rooted at a configurable directory)
- `workflow.status` delegates to the workflow's status provider

The MCP server is a **binding** — it exposes existing
capabilities over the MCP protocol. Tool execution still
passes through the same validation and evidence-recording
paths.

### MCP tools

| Tool | Description | Input |
| --- | --- | --- |
| `repository.inspect` | List repository structure | `path?` |
| `repository.search` | Search files for a query | `query`, `path?`, `maxResults?` |
| `file.read` | Read a file (bounded) | `path`, `offset?`, `limit?` |
| `knowledge.search` | Search the knowledge base | `query`, `topK?` |
| `workflow.status` | Get workflow/run status | `runId?` |

All tools are read-only. All inputs are validated against
JSON Schema. All results are structured JSON. All operations
are local and deterministic.

### MCP self-test

The `scripts/mcp-self-test.mjs` script verifies the MCP
server creation, tool input validation, knowledge search,
and tool exposure — all locally with zero network access.

## Skills architecture (Milestone 3)

Skills are version-controlled Markdown files with YAML
front matter metadata:

```
skills/
  repository-analysis/SKILL.md
  safe-code-change/SKILL.md
  verification/SKILL.md
```

```
src/skills/
  skill.ts          Skill, SkillMetadata, InjectedSkill types
  skill-loader.ts   Discovery, front matter parsing, loading
  skill-selector.ts Deterministic selection by tags + keywords
```

### Skill lifecycle

1. **Discovery** — `loadSkills()` scans a directory for
   subdirectories containing `SKILL.md` files.
2. **Metadata parsing** — `parseSkillFrontMatter()` extracts
   name, description, version, and tags from YAML front
   matter (supports both block-style and flow-style arrays).
3. **Loading** — Each skill is loaded with its metadata and
   instruction body.
4. **Selection** — `selectSkills()` deterministically selects
   the top-k most relevant skills for a query based on tag
   matches (+3), name keyword matches (+2), and description
   keyword matches (+1).
5. **Injection** — Selected skills are injected into the
   agent context as `InjectedSkill` objects.

### Trust boundary: INSTRUCTIONS

Skill content is treated as INSTRUCTIONS — it guides agent
behavior but never executes arbitrary commands. All tool
execution still passes through the `ToolRegistry`. Skills
are version-controlled and independently testable.

## Trust boundaries (Milestone 3)

The system enforces clear trust boundaries:

| Content type | Treatment | Execution path |
| --- | --- | --- |
| Retrieved knowledge | DATA | Never executed; informs agent context |
| Skill content | INSTRUCTIONS | Guides behavior; never executes directly |
| Tool calls | Executed | Through ToolRegistry with validation |
| File access | Bounded | Rooted at configurable directory |
| MCP inputs | Validated | JSON Schema validation before execution |

Neither retrieved content nor skill content may execute
arbitrary commands. Tool execution always passes through
the `ToolRegistry` with input validation and evidence
recording. File access remains bounded by the existing
architecture (rooted at a configurable directory). MCP inputs
are validated against JSON Schema before processing.

Advanced prompt-injection detection and policy evaluation
will be added in the next milestone.

## Reliability and safety layer (Milestone 4)

Milestone 4 adds an evaluation engine, a capability policy
engine, deterministic prompt-injection defenses, human
approval for sensitive actions, and evidence-backed quality
scoring. Everything remains offline and deterministic.

```
src/evaluation/
  metrics.ts     MetricResult, ratio/binary metrics, aggregate score
  assertions.ts  Reusable assertion helpers
  test-case.ts   EvaluationTestCase / ExpectedOutcome types
  dataset.ts     Version-controlled evaluation suite (8 cases)
  evaluator.ts   evaluateRun(): workflow -> metrics + pass/fail
  report.ts      EvaluationReport, buildReport, formatReport
src/policy/
  capabilities.ts  READ, SEARCH, KNOWLEDGE_RETRIEVE, WRITE_WORKSPACE,
                   EXECUTE_SAFE_COMMAND, COMMIT, PUSH, CREATE_PR
  decisions.ts     ALLOW / DENY / REQUIRE_APPROVAL decision records
  policy-engine.ts PolicyEngine: evaluate(capability)
src/security/
  injection-detector.ts  Deterministic SAFE / SUSPICIOUS / BLOCKED
src/approval/
  approval-request.ts  ApprovalRequest, ApprovalDecision, ApprovalActionType
  approval-manager.ts  ApprovalManager (pending / approve / reject)
src/tools/
  policy-gate.ts  PolicyGate interface + DefaultPolicyGate
```

### Tool security: one chokepoint, no bypass

The policy layer is enforced **inside** `ToolRegistry.execute()`,
not in a wrapper. `ToolRegistry` is the single registry every
agent already receives through `AgentContext`, so enforcing the
gate there makes it impossible for an agent to invoke a tool
without passing policy:

```
Agent -> ToolCallRequest -> ToolCaller -> ToolRegistry.execute()
       -> resolve tool
       -> schema validation (declared input schema)
       -> policy evaluation   (ALLOW | DENY | REQUIRE_APPROVAL)
       -> injection check on arguments
       -> human approval when required
       -> execute
       -> injection check on output
       -> ToolCallResult -> evidence
```

- The gate is an interface owned by the registry
  (`PolicyGate`); `ToolRegistry` depends on the interface only,
  so policy remains swappable and testable.
- `PolicyDeniedError` (code `policy_denied`) is thrown on
  refusal. `ToolCaller` converts it into an `ok: false` result
  and records a `tool.policy` evidence record with the decision,
  refusal reason and tool name — a refusal is auditable rather
  than a silent failure.
- **With no gate configured the registry is unguarded**, so
  Milestones 1-3 behaviour is byte-for-byte preserved. This is
  asserted by tests.
- `onAudit` listeners receive every decision (allowed, denied,
  suspicious) for hosts that want to surface it.

### Policy model

Capabilities map to one of three decisions. The default policy:

| Capability | Default decision |
| --- | --- |
| `READ`, `SEARCH`, `KNOWLEDGE_RETRIEVE` | ALLOW |
| `WRITE_WORKSPACE` | ALLOW |
| `EXECUTE_SAFE_COMMAND` | REQUIRE_APPROVAL |
| `COMMIT`, `PUSH`, `CREATE_PR` | REQUIRE_APPROVAL |

`PolicyEngine.TOOL_CAPABILITIES` declares a capability for every
tool the system ships with. A tool that is **absent** from that
map is **denied** by the gate with refusal reason
`unknown_tool`, before any capability is considered. Adding a
tool to the registry therefore never implicitly grants it
access — the policy owner must authorize it explicitly:

```ts
engine.authorizeTool('my.custom.tool', 'READ');   // now callable
engine.unauthorizeTool('my.custom.tool');        // denied again
engine.authorizedToolNames;                       // audit what is allowed
```

The boundary is deliberate: a tool that is not *registered at
all* still raises `ToolNotFoundError` from the registry
lookup. That is a lookup failure, not a policy decision, so
the two conditions are never conflated in the evidence log.
Default-deny is a property of an **armed gate**; an unguarded
registry (no `policy` configured) stays permissive exactly as in
Milestones 1-3.

Custom rules override defaults:

```ts
new PolicyEngine({ rules: [{ capability: 'READ', decision: 'DENY' }] });
```

Pass `policy` to `createComposition()` to arm the gate; omit it
to leave agents unguarded.

### Evaluation metrics

`evaluateRun()` scores a workflow against an `EvaluationTestCase`
and returns a `MetricResult` per metric, an aggregate score in
`[0, 1]`, pass/fail, human-readable failure explanations and
evidence references. Metrics:

| Metric | What it checks |
| --- | --- |
| `task_completion` | run outcome matches the expected outcome |
| `structured_output_validity` | output is a valid JSON object |
| `tool_call_correctness` | ratio of successful tool calls |
| `dependency_correctness` | dependencies resolved (run completed) |
| `retrieval_relevance` | retrievals returned relevant chunks |
| `source_attribution` | every retrieved chunk cites a source |
| `evidence_compleness` | evidence records exist |
| `policy_decision_consistency` | each decision agrees with its outcome (ALLOW ran, DENY did not) |
| `policy_enforcement` | no denied tool call ever executed |
| `policy_violation_attempts` | share of calls with no violation attempt; counts attempted violations |
| `verifier_result` | verifier verdict, when one ran |
| `repair_behavior` | repair count is within the bound |

#### Policy compliance is measured, not inferred

The policy metrics are computed from the `tool.policy`
evidence records the gate actually produced, supplied as
`policyDecisions` on `EvaluationContext`. They are deliberately
**not** derived from whether the run succeeded:

- A run that fails for an unrelated reason is not scored as a
  policy violation.
- A run that succeeds while attempting denied tools still
  records the attempts, and `unauthorized_tool_request` cases
  additionally require that at least one violation was observed.

`ALLOW`, `DENY` and `REQUIRE_APPROVAL` are counted separately in
the metric's `byDecision` details, alongside the distinct
refusal reasons, so a score is always explainable. When no
policy evidence is supplied the three policy metrics are
**skipped** rather than guessed.

Every gate decision — allowed ones included — is recorded as
`tool.policy` evidence, so compliance can be audited rather than
inferred. `ToolRegistry.executeWithAudit()` returns the
decisions observed during a call; `execute()` delegates to it
and keeps its Milestone 1-3 signature unchanged. Decisions
survive a refusal because they are attached to the thrown
`PolicyDeniedError`.

Scoring is deterministic: `aggregateScore` is the unweighted
mean of metric scores and `overallPass` requires every metric to
pass, plus the test case's `minScore`. Every failure carries an
explanation string, so a score is always traceable to a cause.

### Evaluation dataset

`src/evaluation/dataset.ts` holds eight version-controlled cases:
successful research, invalid structured output, irrelevant
retrieval, unauthorized tool request, prompt injection, failed
verification requiring repair, persistent failure after one
repair, and approval-required action. Each declares
`shouldSucceed`, optional `minScore`, and required / expected-fail
metrics.

### Prompt-injection defense (and its limits)

`analyzeText(text, source)` classifies untrusted content as
`SAFE`, `SUSPICIOUS` or `BLOCKED` and returns the reason and
source. Patterns cover instruction overrides, secret
disclosure, safety bypass, command execution, privilege
escalation and trusted-message impersonation.

Severity rules: a blocked payload requires either multiple
critical patterns or an injection combined with other signals;
isolated high-risk phrases are `SUSPICIOUS` and are allowed
through but still reported. `SUSPICIOUS` output passes to the
agent while remaining visible in the audit trail.

**This is a deterministic first-line defense, not a guarantee
against all attacks.** It is pattern-based, so obfuscated,
encoded, multilingual or semantically indirect attacks can
evade it. It complements — and does not replace — the structural
guarantees (schema validation, capability policy, approval,
bounded execution). Do not treat a `SAFE` verdict as proof that
content is benign.

### Trust boundaries (Milestone 4)

| Content | Treatment | Enforcement |
| --- | --- | --- |
| Retrieved knowledge | DATA | labelled, never executed |
| Skill content | INSTRUCTIONS | guides behavior, never executes |
| Tool arguments/output | UNTRUSTED | injection-checked, blocked when `BLOCKED` |
| Tool calls | Governed | capability policy inside the registry |
| Sensitive actions | PENDING_APPROVAL | human approval required before execution |
| Filesystem / MCP inputs | Bounded | root-bounded, schema-validated |

### Approval flow

`ApprovalManager` tracks requests across
`PENDING_APPROVAL -> APPROVED | REJECTED`. For
`REQUIRE_APPROVAL` capabilities the gate creates a request and
awaits the configured handler; the call executes only on
`APPROVED`. With no handler configured the call is **blocked**
(`approval_unavailable`) rather than allowed — a missing
approver never means "permit". Approval decisions are recorded
as evidence by the caller. Approval is programmatic for
deterministic testing; no UI exists yet.

### Repair and re-evaluation

The M2 bounded repair loop is unchanged and still bounded to
`maxRepairCycles` (default 1), so an infinite loop is impossible.
M4 adds the re-evaluation step: after repair, the verifier runs
again and the evaluator confirms the repair actually resolved
the original failure — comparing the first failed verdict
against the post-repair verdict rather than assuming success.
The `repair_behavior` metric additionally fails any run whose
repair count exceeds the bound.

### Evidence trail

Milestone 4 reuses the existing append-only event/evidence
system:

- `tool.policy` — every policy decision (ALLOW / DENY /
  REQUIRE_APPROVAL), refusal reason, safety level, allowed flag
- `tool.call` / `tool.result` — unchanged, now able to carry a
  policy refusal as an `ok: false` result
- `evaluation.*` — metric results, failures, final quality score
- `approval.requested` / `approval.result` — approval lifecycle
- `repair.started` / `repair.completed` (M2) plus the
  re-evaluation outcome

Every record is content-addressed with SHA-256 and persisted to
SQLite before the emitting agent continues.

## Application service layer (Milestone 5-A)

A reusable service layer sits above the domain, engine and
persistence layers. Transports (CLI, REST API, any future
dashboard) call these services; they never reach into the
engine directly.

```
src/application/
  workflow-service.ts   createRun, executeRun, executeGraph
  run-service.ts        getRun, listRuns, getEvents, getEvidence,
                        getMetrics, getTasks, getSpans, getCounters
  approval-service.ts   submit, approve, reject, listPending
  evaluation-service.ts evaluateRun (projects stored evidence)
```

There is **no second workflow engine**. `WorkflowService`
delegates to the existing `AIWorkflow` / `Orchestrator` and adds
only tracing plus a transport-safe summary. Likewise
`EvaluationService` builds an `EvaluationContext` from stored
evidence and delegates to the Milestone 4 evaluator.

### Run scoping: workflow runs vs member runs

`AIWorkflow` creates one orchestrator run per phase (planner,
main, repairs) and scopes its own evidence under a separate
`workflowId` that is not itself a persisted run row. To make a
workflow addressable as one resource, `WorkflowService` writes a
run row for the workflow id and records the member run ids in its
metadata. `RunService.scopeRunIds()` reads that metadata, and
`getEvents` / `getEvidence` / `getTasks` / `getMetrics` aggregate
across the scope, re-sorted by the global event sequence.

Without this, `GET /api/runs/:id` would 404 on the id that
`POST /api/workflows` returned.

## Observability (Milestone 5-A)

Local, in-process tracing and metrics. There is **no
OpenTelemetry SDK dependency, no exporter and no network
endpoint** — only OTel-compatible naming and structure.

```
src/observability/
  spans.ts           Span / SpanContext, startSpan, endSpan
  tracer.ts          LocalTracer: start, end, withSpan, finalizeRun
  metrics.ts         MetricRegistry + METRIC_NAMES
  instrumentation.ts instrument(): wires the tracer to existing signals
src/persistence/
  observability-repository.ts   spans + run_metrics tables
  migrations/0002_observability.sql
```

### Instrumentation adds no engine hooks

`instrument()` observes only what the system already emits: the
synchronous event bus (`task.retried`) and the append-only
evidence log (`agent.start`/`agent.end`, `model.call`,
`tool.call`/`tool.result`, `verification`, `repair.started`), plus
the tool registry's policy audit hook. No orchestrator or agent
code is modified, so Milestones 1-4 behaviour is untouched.

Note that agent and workflow lifecycle arrive as **evidence
kinds**, not typed events — the bus only carries the 12 M1 event
types. The instrumentation projects them from
`evidence.recorded`.

### Spans

Mirrors the OTel shape: `spanId`, `parentSpanId`, `name`, `kind`,
`status`, start/end timestamps, `durationMs`, and free-form
attributes. Token usage is mirrored into
`gen_ai.usage.*` attributes so an exporter reading attributes
alone still sees the numbers.

Finished spans are persisted **immediately**, under the run id
they were started with. This matters because a workflow's agent
and tool spans belong to member runs, not to the workflow id —
buffering until the workflow finished would drop them.
`finalizeRun(runId)` then derives and persists that run's metrics.

### Metrics

`MetricRegistry.fromSpans()` computes the standard set from the
spans, so numbers always agree with the trace:

| Metric | Source |
| --- | --- |
| `workflow.run.duration_ms` / `workflow.run.count` | the workflow span |
| `agent.duration_ms` | summed `agent.execute` spans |
| `tool.call.count` / `tool.error.count` | `tool.call` spans |
| `error.count` | any span with `status = error` |
| `retry.count` | `task.retry` spans |
| `repair.count` | `workflow.repair` spans |
| `policy.denial.count` | registry audit refusals |
| `gen_ai.usage.{input,output,total}_tokens` | spans reporting usage |

A `task.retry` span counts as exactly one retry; its
`retry.count` attribute is deliberately **not** added again, which
would double count.

### Token availability

Token metrics are nullable throughout. A dimension is reported
only if at least one span supplied it, so "the provider reported
no usage" stays `null` and is never flattened to `0`. The API
exposes `tokenUsageAvailable` alongside the three nullable fields.
The deterministic provider always reports usage, so offline runs
produce real numbers.

## REST API (Milestone 5-A)

```
src/api/
  server.ts        createApiApp, startApiServer (Node http via Hono)
  schemas.ts       Zod request/response contracts
  routes/routes.ts transport-only handlers
  routes/responses.ts  ok / fail helpers
  main.ts          entry point with graceful shutdown
scripts/
  api-smoke-test.ts  end-to-end smoke test on an ephemeral port
```

Endpoints:

| Method | Path | Service call |
| --- | --- | --- |
| GET | `/health` | health + determinism flag |
| GET | `/api/stats` | `RunService.getStats` + pending approval count |
| GET | `/api/approvals` | `ApprovalService.listPending` (optionally `?runId=`) |
| GET | `/api/runs` | `RunService.listRuns` |
| GET | `/api/runs/:id` | `RunService.getRun` / `getTasks` |
| GET | `/api/runs/:id/events` | `RunService.getEvents` |
| GET | `/api/runs/:id/evidence` | `RunService.getEvidence` |
| GET | `/api/runs/:id/evaluation` | `EvaluationService.evaluateRun` |
| GET | `/api/runs/:id/metrics` | `RunService.getMetrics` |
| POST | `/api/workflows` | `WorkflowService.executeRun` |
| POST | `/api/workflows/:id/approve` | `ApprovalService.approve` |
| POST | `/api/workflows/:id/reject` | `ApprovalService.reject` |

`GET /api/runs` additionally joins `durationMs`,
`evaluationScore`, `evaluationPassed` and `approvalState` per
row, so the run table renders from a single request.

### Local security posture

This is a **local, single-user development system with no
authentication layer**. That is a deliberate trade-off, not an
oversight:

- The backend binds `127.0.0.1` by default. Setting
  `API_HOST=0.0.0.0` would expose an unauthenticated service to
  the network — do not do this outside a trusted machine.
- Adding authentication would require storing or fetching
  credentials, which would break the zero-cost, no-secret rule.
  It belongs in a future milestone, ideally as an optional
  reverse-proxy layer rather than an in-process secret store.
- CORS is off by default; enabling it requires an explicit
  allowlist, and a `*` entry throws at startup.

## Control-plane dashboard (Milestone 5-B)

Handlers are transport-only: parse with Zod, call one service
method, shape the response. No orchestration, persistence or
policy logic lives in a route.

### Local-only posture

- Binds to `127.0.0.1` by default; `API_HOST` overrides it.
- CORS is **disabled** by default. Enabling it requires an
  explicit origin allowlist, and a `*` entry throws at startup.
- No authentication is configured, because the server is local
  and single-user. Adding it would require a secret store, which
  would break the zero-cost rule.
- No secret is read, required or returned. `maxRepairCycles` is
  capped at 1 so an HTTP request can never create a loop.
- Errors always use the structured `{ error: { code, message,
  details? } }` shape; domain `DomainError` codes are mapped to
  sensible statuses instead of leaking stack traces.

### Graceful shutdown

`src/api/main.ts` handles SIGINT/SIGTERM, closes the HTTP server
(releasing the port) and then closes the database, so no
migration lock or WAL file is left behind.

## Control-plane dashboard (Milestone 5-B)

```
apps/dashboard/
  src/
    api/          client.ts (typed fetch), types.ts, map.ts, format.ts
    hooks/        useResource.ts (loading/error/refresh + polling)
    components/   ui.tsx, Overview.tsx, RunList.tsx, RunDetailPanels.tsx
    App.tsx       shell: selected run + panel wiring
    styles.css    hand-written; system fonts only
```

React 18 + Vite 7 + TypeScript. Two runtime dependencies
(`react`, `react-dom`); no UI kit, no icon package, no CSS
framework, no webfont, no analytics. The stylesheet uses system
fonts, so the dashboard makes **zero external network requests**.

### Layering

```
App.tsx  ──►  hooks/useResource  ──►  api/client  ──►  REST API
   │                                        │
   └──►  components/*  ◄──  api/map.ts ◄── types.ts
```

- `api/client.ts` owns URL construction, the structured error
  envelope, and shallow response-shape validation. Nothing else.
- `api/map.ts` reshapes payloads into view models; it never
  recomputes a score or decides an approval outcome.
- `api/format.ts` holds the display rules as pure functions.
- `hooks/useResource.ts` owns the loading/error/refresh state
  machine.

All three non-visual layers are unit tested directly, so the
tests need no DOM.

### Unavailable data is never invented

The backend reports unobserved numeric metrics as `null`. The
dashboard renders those as **N/A** (and unavailable metric cells
are styled in italics to distinguish them from a real value). A
measured `0` still renders as `0`. This distinction is asserted
throughout `map.test.ts`.

### Two aggregation rules worth noting

- **Run list excludes phase runs.** A workflow creates one
  orchestrator run per phase (planner, main, repairs).
  `RunService.listRuns()` derives the set of member run ids from
  stored metadata and filters them out, so one workflow renders
  as one row. The members stay reachable via `scopeRunIds`.
- **`/api/stats` is computed server-side.** The dashboard needs
  tool-call and token totals across all runs; computing that in
  the browser would mean one metrics request per run. Aggregation
  therefore stays on the server, next to the stored data.

### Approval actions delegate

The Approve/Reject buttons call
`POST /api/workflows/:id/approve|reject` and then re-read the run
and approvals from the server. The UI never decides an outcome
locally and never shows an optimistic state that the backend did
not confirm.

### Refresh model

Simple interval polling (5 s) on the stats, run list and the
selected run's live panels. Polling pauses while the tab is
hidden and while a request for the same resource is already in
flight. Deliberately **no WebSockets**: for a single-user local
tool, polling is simpler and avoids a persistent connection in
the backend.

`useResource` forces a fetch when the resource's identity changes
(selecting a different run) even if the previous fetch is still
pending, and discards any response that resolves after a newer
one. A global in-flight guard would have silently skipped the new
run — the force path exists for exactly that case.

## Local-only execution and deterministic mode

## Out of scope (deliberately)

A React dashboard, GitHub automation, WebSockets, cloud
deployment and Kubernetes belong to later milestones.
Autonomous destructive shell execution is likewise deliberately
excluded.
