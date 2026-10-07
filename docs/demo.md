# Milestone 5-C: Final Git/GitHub Integration & End-to-End Portfolio Demo

## Objective

Run a fully deterministic end-to-end portfolio demo from policy through approval,
Git, and GitHub simulation — all without network access, API keys, or paid services.

The sequence exercises every governance layer and demonstrates that the system
is safe, reproducible, and observable from policy to evidence.

```
→ Planner
→ RAG
→ Skill
→ Researcher
→ MCP
→ Builder
→ Verifier FAIL
→ Repair
→ Verifier PASS
→ Evaluation PASS
→ Policy
→ Approval REQUIRED
→ Approval APPROVED
→ Git PASS
→ GitHub SIMULATED
→ Evidence PASS
```

## Deterministic Guarantees

| Property | Guarantee |
|---|---|
| **Provider** | Deterministic LLM provider, zero network, zero API keys |
| **RAG** | Local TF-IDF index; no external search or embedding service |
| **Injection detection** | Pattern-based, deterministic, first-line defense |
| **GitHub integration** | Optional: `GithubAdapter` (gh CLI) or `GithubSimulator` (SIMULATED) |
| **Git operations** | Real `git` CLI, workspace-bounded, policy-gated |
| **Simulation labels** | Every result explicitly labelled `SIMULATED`; never mistaken for live |
| **Id determinism** | SHA-256-derived IDs; same inputs → same outputs |

## Two GitHub Modes

1. **Live** (`GithubAdapter`) — uses the `gh` CLI when present and authenticated.
   Reports `available: false` honestly when `gh` is missing or unauthenticated.
   Never fabricates success.

2. **Simulation** (`GithubSimulator`) — deterministic, no network.
   All results carry `label: 'SIMULATED'` and `mode: 'simulated'` in evidence.
   URLs use `.invalid` TLD so they can never be routed to a real GitHub host.

## Demo Sequence (per the objective)

| Step | What Happens | Governance |
|---|---|---|
| **Planner** | Planner agent produces an execution plan using RAG + skill selection. | Policy gate evaluates every tool call; READ capabilities are ALLOW. |
| **RAG** | Knowledge retrieval from the local TF-IDF index grounds the planner. | Recorded as `knowledge.retrieval` evidence. |
| **Skill** | Deterministic skill selection injects reusable instructions. | Recorded as `skill.selected` evidence. |
| **Researcher** | Researcher agent performs tool-augmented research. | Tool calls flow through registry → policy → approval. |
| **MCP** | In-process MCP server `knowledge.search` returns relevant chunks. | MCP tool registered and evaluated through the governed path. |
| **Builder** | Builder agent produces an initial (defective) artifact. | First verifier rejection is intentional → repair cycle. |
| **Verifier FAIL** | Verifier rejects the builder's first attempt (structured failure). | Verification event recorded; `verificationPassed = false`. |
| **Repair** | Builder re-executes with the structured failure report. | Bounded to exactly one repair cycle (`maxRepairCycles = 1`). |
| **Verifier PASS** | Re-verification passes after the repair. | `verificationPassed = true`. |
| **Evaluation PASS** | Run evaluated against test case `tc-006-failed-verification`. | Score ≥ threshold; passed = true. |
| **Policy** | Policy decisions from the evidence log are inspected. | Every tool call was evaluated; `tool.policy` events recorded. |
| **Approval REQUIRED** | `git.commit` requires `COMMIT` approval (default: `REQUIRE_APPROVAL`). | Approval submitted; decision shown as `REQUIRE_APPROVAL`. |
| **Approval APPROVED** | Human (demo) approves the pending `git.commit`. | Decision flipped to `APPROVED`; commit proceeds. |
| **Git PASS** | Real `git` operations (status, diff, log, commit) on a temporary repo. | `GitService` workspace-bound; every command validated against the root. |
| **GitHub SIMULATED** | `GithubSimulator` produces `SIMULATED` push and PR results. | IDs derived from SHA-256 of inputs; always labelled `SIMULATED`. |
| **Evidence PASS** | Evidence log contains all recorded events (tool calls, policy, verification). | Append-only event stream; audit-ready. |

## Running the Demo

```bash
# From the repository root:
pnpm demo:final
```

The output is a Markdown-formatted summary of every stage, with pass/fail marks,
governed-pipeline visibility, and verified metrics (tool call counts, policy
decisions, evidence count, token usage if the instrumentation is active).

## Design Decisions

- **No bypass** of the existing `ToolRegistry → PolicyGate → Approval` path.
  Git tools are registered as `Tool` implementations; they inherit the gate.
- **GitHub adapter never fabricates success**. When `gh` is missing or unauthenticated,
  `available: false` is returned with an explanatory reason.
- **GitHub simulation is deterministic**. SHA-256 of `operation\nseed` produces
  8-character IDs; PR numbers are in the range 100–999; URLs use `.invalid`.
- **Workspace guard uses lexical path resolution** (no symlink following). A real
  deployment should additionally resolve `realpath` if symlinks are present.
- **Git diff output is size-capped at 20,000 characters** to prevent flooding
  LLM prompts or evidence records.
- **All M1–M5-B tests (512+) must remain green** after these changes.

## Artifacts

- `docs/demo.md` — this file
- `src/orchestrator/final-demo.ts` — the demo runner
- `package.json` — added `pnpm demo:final` script
- Mermaid diagrams in `docs/architecture.md` (updated)
- README.md updated with portfolio-ready metrics (see below)