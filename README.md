# Digital Workforce OS

Governed multi-agent AI workflow system. Milestone 1 delivers the
deterministic, fully local foundation: task graphs, an orchestrator,
agent and tool abstractions, SQLite persistence, and an append-only
event/evidence log.

- **Completely free to develop, test and run** — no API keys, no
  paid AI APIs, no cloud services. Milestone 1 executes entirely
  with the local deterministic provider.
- **Deterministic** — seeded provider, injectable clocks and
  sequential IDs make every test and demo reproducible.
- **Auditable** — every lifecycle transition is an event persisted
  to an append-only SQLite table; evidence records are
  content-addressed with SHA-256.

## Requirements

- Node.js >= 20
- pnpm >= 9

## Quick start

```sh
pnpm install
pnpm test        # vitest — 90 tests
pnpm typecheck   # tsc --noEmit
pnpm demo        # research -> implementation -> verification workflow
pnpm build       # compile to dist/ (plus asset copy)
pnpm verify      # typecheck + test + demo
```

## Demo

```sh
pnpm demo                       # default: data/demo.db, concurrency 2
pnpm demo --verbose             # print every persisted event
pnpm demo --json                # machine-readable summary
pnpm demo --db path/to.db       # custom database
pnpm demo --concurrency 4       # parallel task execution
pnpm demo --continue            # keep going after task failures
```

The demo builds the canonical sample workflow:

```
research -> implementation -> verification
```

executes it end-to-end with the deterministic provider (including
tool calls through the registered `word_count` and `calculator`
tools), prints a readable summary, and reads every run, task and
event back from SQLite to prove persistence.

## Project layout

```
src/
  core/         IDs, Clock, errors, Result, statuses, canonical JSON
  graph/        TaskGraph: validation, cycle detection, topological order
  orchestrator/ lifecycle, ready queue, concurrency, retries, cancellation
  agents/       Agent interface, registry, deterministic agent
  tools/        Tool interface, schema validation, registry, builtins
  events/       typed events, event bus, evidence log
  persistence/  SQLite (WAL), migrations, repositories
  providers/    Provider interface, deterministic provider
  index.ts      composition root
  cli.ts        demo CLI
tests/          90 unit + integration tests
docs/           architecture.md
```

See [docs/architecture.md](docs/architecture.md) for module
boundaries, dependency inversion, the execution lifecycle,
persistence design, and how real LLM providers plug in later.

## License

MIT
