# Digital Workforce OS

Guided multi-agent AI workflow system. Milestone 1
delivered the deterministic, fully local foundation: task
graphs, an orchestrator, agent and tool abstractions,
SQLite persistence, and an append-only event/evidence
log. Milestone 2 turned it into a real AI-agent execution
layer: an LLM provider abstraction, Zod structured
outputs, a planner, specialist agents (researcher,
builder, verifier), structured tool calling, and a
bounded repair cycle. Milestone 3 added three AI Engineer
capabilities: local RAG / knowledge retrieval, real MCP
integration, and reusable agent Skills. Milestone 4 added the
reliability and safety layer: a deterministic evaluation
engine, a capability policy engine, prompt-injection defenses,
human approval, and evidence-backed quality scoring.
Milestone 5-A adds the production-style platform: an
application service layer, local observability, and a REST API.

- **Completely free to develop, test and run** — no
  API keys, no paid AI APIs, no cloud services. The
  deterministic provider is the default and runs the
  full AI workflow offline; an optional
  OpenAI-compatible provider can be configured
  explicitly.
- **Provider-neutral** — agents depend on the
  `LLMProvider` interface (text + structured
  generation, model metadata, usage, timeouts), so
  the model backend is swappable without touching the
  orchestrator.
- **Structured and verified** — every model-generated
  output is validated against Zod schemas at three
  layers (provider, agent, workflow); a verifier
  agent can fail work and trigger exactly one
  automatic repair cycle.
- **Deterministic** — seeded provider, injectable
  clocks and sequential IDs make every test and demo
  reproducible.
- **Auditable** — every lifecycle transition is an
  event persisted to an append-only SQLite table;
  evidence records (agent lifecycle, model calls,
  structured validation, tool calls, verification,
  repairs, knowledge retrieval, skill selection) are
  content-addressed with SHA-256.
- **Knowledge-aware (M3)** — local RAG retrieval with
  deterministic TF-IDF ranking, source attribution,
  and grounded context construction. Retrieved content
  is always treated as DATA, never as instructions.
- **MCP-integrated (M3)** — a real stdio MCP server
  using the official TypeScript SDK, exposing safe
  read-only tools that reuse the existing ToolRegistry.
- **Skill-driven (M3)** — version-controlled Markdown
  skills with discovery, metadata parsing, deterministic
  selection, and injection into agent contexts.
- **Evaluated (M4)** — a deterministic evaluation engine scores
  every run against a version-controlled dataset (task
  completion, structured validity, tool-call correctness,
  retrieval relevance, source attribution, evidence
  completeness, policy compliance, verifier result, repair
  behavior) with explainable failures and evidence refs.
- **Governed (M4)** — capability policy (ALLOW / DENY /
  REQUIRE_APPROVAL) enforced *inside* `ToolRegistry.execute()`,
  so no agent can invoke a tool without passing policy. Sensitive
  actions (COMMIT / PUSH / CREATE_PR / EXECUTE_SAFE_COMMAND)
  require human approval before running.
- **Injection-aware (M4)** — a deterministic detector treats
  retrieved documents, repository files, and tool output as
  untrusted DATA and classifies them SAFE / SUSPICIOUS /
  BLOCKED. It is a first-line defense, **not** a guarantee
  against all attacks.
- **Service-layered (M5-A)** — an application service layer
  (`createRun`, `executeRun`, `getRun`, `getEvents`,
  `getEvidence`, `getEvaluation`, `getMetrics`, `approve`,
  `reject`) sits above the engine. The CLI and REST API both use
  it, and no transport duplicates orchestration.
- **Observable locally (M5-A)** — in-process spans and metrics
  using OpenTelemetry-compatible naming, persisted through the
  existing SQLite layer. No OTel SDK, no exporter, no network
  endpoint. Unavailable token usage is reported as `null`, never
  invented as `0`.
- **Local REST API (M5-A)** — a loopback-bound JSON API over the
  services, with Zod request validation, structured errors, CORS
  off by default, and graceful shutdown. Fully offline.

## Requirements

- Node.js >= 20
- pnpm >= 9

## Quick start

```sh
pnpm install
pnpm test        # vitest — 468 tests
pnpm typecheck   # tsc --noEmit
pnpm demo        # M1: research -> implementation -> verification
pnpm demo:ai     # M2: planner -> researcher -> builder -> verifier (with repair)
pnpm demo:safety # M4: evaluation, policy, approval, injection defense
pnpm api         # M5-A: local REST API on http://127.0.0.1:4317
pnpm smoke:api   # M5-A: end-to-end API smoke test (offline)
pnpm build       # compile to dist/ (plus asset copy)
pnpm verify      # typecheck + test + demo
```

`API_HOST` / `API_PORT` / `API_DB` override the API defaults.

## Demo

```sh
pnpm demo                       # default: data/demo.db, concurrency 2
pnpm demo --ai                  # AI workflow demo (fully offline)
pnpm demo --verbose             # print every persisted event
pnpm demo --json                # machine-readable summary
pnpm demo --db path/to.db       # custom database
pnpm demo --concurrency 4       # parallel task execution
pnpm demo --continue            # keep going after task failures
```

The default demo builds the canonical Milestone 1
workflow:

```
research -> implementation -> verification
```

The AI demo (`--ai`) runs the Milestone 2 workflow with
the deterministic provider — zero network access:

```
Objective -> Planner -> Researcher -> Builder -> Verifier
                                (one automatic repair cycle on failure)

Planner       ✓
Researcher    ✓
Builder       ✓
Verifier      ⚠   <- verifier rejects the first attempt
Repair        ✓   <- builder receives the failure report and repairs
Verifier      ✓   <- second verification passes
Final         SUCCESS
```

Both demos execute end-to-end, print a readable summary,
and read every run, task and event back from SQLite to
prove persistence.

The safety demo (`--safety`) runs the full governed pipeline
offline and deterministically:

```
PLAN                 ✓  planner produced an execution plan
RAG                  ✓  retrievals grounded the agents
SKILL                ✓  skills injected reusable instructions
TOOL REQUEST         ✓  tool calls succeeded through the registry
POLICY               ✓  capability policy evaluated every call
VERIFIER             ⚠  verifier rejects the first attempt
REPAIR               ✓  bounded repair cycle
RE-EVALUATION        ✓  re-verification confirms the fix
FINAL EVALUATION     ✓  PASS
APPROVAL RESULT      ✓  APPROVED — COMMIT executed after approval
INJECTION DEFENSE    ✓  BLOCKED untrusted input
```

## Project layout

```
src/
  core/         IDs, Clock, errors, Result, statuses, canonical JSON
  graph/        TaskGraph: validation, cycle detection, topological order
  orchestrator/ lifecycle, ready queue, concurrency, retries, cancellation
                AIWorkflow: planner -> specialists -> verifier + repair loop
  agents/       Agent interface, registry, deterministic agent,
                Zod structured schemas, tool caller,
                planner / researcher / builder / verifier agents
  tools/        Tool interface, schema validation, registry, builtins
  events/       typed events, event bus, evidence log
  persistence/  SQLite (WAL), migrations, repositories
  providers/    Provider interface, deterministic provider,
                LLMProvider interface, deterministic LLM adapter,
                optional OpenAI-compatible provider
  knowledge/    RAG: document, chunker, inverted index, retriever,
                knowledge store, context builder
  skills/       Skill types, loader (discovery + parsing), selector
  mcp/          MCP tools, stdio server, client
  evaluation/   M4: metrics, assertions, test cases, dataset,
                evaluator, report
  policy/       M4: capabilities, decisions, policy engine
  security/     M4: deterministic prompt-injection detector
  approval/     M4: approval requests, decisions, manager
  tools/        Tool interface, schema validation, registry, builtins,
                policy gate (enforced inside the registry)
  observability/ M5-A: spans, tracer, metrics, instrumentation
  application/  M5-A: workflow, run, approval, evaluation services
  api/          M5-A: REST server, Zod schemas, routes, entry point
  index.ts      composition root
  cli.ts        demo CLI (graph demo + AI demo + safety demo)
skills/           Version-controlled Markdown skills
  repository-analysis/SKILL.md
  safe-code-change/SKILL.md
  verification/SKILL.md
tests/            468 unit + integration tests
docs/             architecture.md
```

## REST API

```sh
pnpm api                                  # 127.0.0.1:4317
curl -s localhost:4317/health

curl -s -X POST localhost:4317/api/workflows \
  -H 'content-type: application/json' \
  -d '{"objective":"Add structured output validation"}'
```

```
GET  /health
GET  /api/runs
GET  /api/runs/:id
GET  /api/runs/:id/events
GET  /api/runs/:id/evidence
GET  /api/runs/:id/evaluation
GET  /api/runs/:id/metrics
POST /api/workflows
POST /api/workflows/:id/approve
POST /api/workflows/:id/reject
```

Loopback-bound by default, CORS disabled unless an explicit
allowlist is configured, no authentication (local, single-user),
and no secret is read or returned.

See [docs/architecture.md](docs/architecture.md) for
module boundaries, dependency inversion, the LLM
provider layer, structured outputs, agent roles, the
tool execution flow, the repair loop, provider
neutrality, RAG architecture, MCP architecture, skills
architecture, the evaluation/policy/approval architecture,
trust boundaries, the application service layer,
observability, the API architecture, and the documented
limits of the prompt-injection detector.

## License

MIT
