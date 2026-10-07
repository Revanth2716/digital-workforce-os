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
integration, and reusable agent Skills.

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

## Requirements

- Node.js >= 20
- pnpm >= 9

## Quick start

```sh
pnpm install
pnpm test        # vitest — 270 tests (90 M1 + 107 M2 + 73 M3)
pnpm typecheck   # tsc --noEmit
pnpm demo        # M1: research -> implementation -> verification
pnpm demo:ai     # M2: planner -> researcher -> builder -> verifier (with repair)
pnpm build       # compile to dist/ (plus asset copy)
pnpm verify      # typecheck + test + demo
```

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
  index.ts      composition root
  cli.ts        demo CLI (graph demo + AI demo)
skills/           Version-controlled Markdown skills
  repository-analysis/SKILL.md
  safe-code-change/SKILL.md
  verification/SKILL.md
tests/            270 unit + integration tests
docs/             architecture.md
```

See [docs/architecture.md](docs/architecture.md) for
module boundaries, dependency inversion, the LLM
provider layer, structured outputs, agent roles, the
tool execution flow, the repair loop, provider
neutrality, RAG architecture, MCP architecture, skills
architecture, and trust boundaries.

## License

MIT
