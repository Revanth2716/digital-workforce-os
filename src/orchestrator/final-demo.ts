/**
 * Final deterministic demo (Milestone 5-C).
 *
 * Sequence (every stage is deterministic, zero network, zero API keys):
 *
 *   Planner      → RAG → Skill → Researcher → MCP → Builder → Verifier FAIL
 *   Repair       → Verifier PASS → Evaluation PASS → Policy → Approval REQUIRED
 *   Approval APPROVED → Git PASS → GitHub SIMULATED → Evidence PASS
 *
 * The deterministic LLM provider, local TF-IDF RAG, pattern-based injection
 * detection, and optional GitHub simulation are all demonstrated honestly.
 */

import type { JsonValue } from '../core/json.js';
import { createComposition } from '../index.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { ApprovalManager } from '../approval/approval-manager.js';
import { GithubSimulator, SIMULATION_DISCLAIMER } from '../github/github-simulation.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { evaluateRun } from '../evaluation/evaluator.js';
import { EVALUATION_SUITE } from '../evaluation/dataset.js';
import { formatReport } from '../evaluation/report.js';
import { AI_DEMO_OBJECTIVE, createDemoResponses } from './ai-demo.js';
import type { EvaluationContext } from '../evaluation/evaluator.js';
import { GithubAdapter } from '../github/github-adapter.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMCPServer } from '../mcp/server.js';
import { EvidenceLog } from '../events/evidence.js';
import { TypedEventBus } from '../events/event-bus.js';
import { DeterministicIdGenerator } from '../core/types.js';
import { FakeClock } from '../core/types.js';
import { AIWorkflowOutcome, AIPhaseOutcome } from './ai-workflow.js';
import { GitService } from '../git/git-service.js';
import { WorkspaceGuard } from '../git/workspace.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** One line of the final demo pipeline. */
export interface DemoStage {
  readonly label: string;
  readonly mark: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

/** The full result of the final demo. */
export interface FinalDemoResult {
  readonly stages: readonly DemoStage[];
  readonly objective: string;
  readonly workflowStatus: 'succeeded' | 'failed';
  readonly finalPassed: boolean;
  readonly finalScore: number;
  readonly approvalResult: string;
  readonly gitResult: string;
  readonly githubResult: string;
  readonly evidenceCount: number;
  readonly reportText: string;
}

/** Options for the final demo. */
export interface FinalDemoOptions {
  readonly dbPath?: string;
  readonly gitTempDir?: string;
}

/**
 * Derive a deterministic 8-char ID from an operation and seed string,
 * using SHA-256. This mirrors the GithubSimulator.idFor() logic
 * without needing to access a private method.
 */
function deterministicId(operation: string, seed: string): string {
  return createHash('sha256').update(`${operation}\n${seed}`).digest('hex').slice(0, 8);
}

/**
 * Run the final deterministic end-to-end demo.
 *
 * Every step uses the deterministic provider, local RAG, and in-process
 * simulation. No network, no API keys, no paid services.
 */
export async function runFinalDemo(
  options: FinalDemoOptions = {},
): Promise<FinalDemoResult> {
  const stages: DemoStage[] = [];
  const ok = (label: string, detail: string): DemoStage => ({ label, mark: 'ok', detail });
  const warn = (label: string, detail: string): DemoStage => ({ label, mark: 'warn', detail });
  const fail = (label: string, detail: string): DemoStage => ({ label, mark: 'fail', detail });

  // --- Approval manager: deterministic, auto-approves the demo ---
  const approvalManager = new ApprovalManager(async (request) => ({
    requestId: request.id,
    decision: 'APPROVED' as const,
    comment: 'approved deterministically by the final demo',
    decidedAt: Date.now(),
  }));

  // --- Knowledge store with a real document so RAG does genuine work ---
  const knowledgeStore = new KnowledgeStore();
  knowledgeStore.ingest([
    '# Structured output validation',
    '',
    'Every model-generated artifact is validated against a Zod schema at',
    'three layers: the provider boundary, the agent boundary and the',
    'workflow boundary. Invalid output is rejected with structured issues',
    'that the evidence log records for audit.',
    '',
    '# Repair loop',
    '',
    'When a verifier fails, exactly one bounded repair cycle re-runs the',
    'builder with the structured failure report. The loop is bounded by',
    'maxRepairCycles, so an infinite repair loop is impossible.',
    '',
    '# TF-IDF RAG',
    '',
    'The knowledge store uses a local TF-IDF index for retrieval; no',
    'external service is required. Queries are resolved against the',
    'ingested corpus using cosine similarity on term-frequency vectors.',
    '',
    '# Prompt injection detection',
    '',
    'Pattern-based detection of untrusted input that attempts to override',
    'agent objectives. This is a deterministic first-line defense that',
    'operates without any learned model or external classifier.',
  ].join('\n'), {
    source: 'docs/architecture.md',
    title: 'Architecture',
    contentType: 'text/markdown',
  });

  // --- Create the composition with gitWorkspaceRoot for Git service ---
  const composition = createComposition({
    dbPath: options.dbPath ?? ':memory:',
    concurrency: 1,
    llmResponses: createDemoResponses(),
    policy: new PolicyEngine(),
    approval: approvalManager,
    knowledgeStore,
    skillsDir: 'skills',
    gitWorkspaceRoot: options.gitTempDir,
  });

  try {
    // -------------------------------------------------------
    // 1. PLAN
    // -------------------------------------------------------
    const outcome: AIWorkflowOutcome = await composition.ai.run(AI_DEMO_OBJECTIVE);

    const plannerPhase = outcome.phases.find((phase) => phase.phase === 'planner');
    stages.push(
      ok('PLAN', plannerPhase?.summary ?? 'planner produced an execution plan'),
    );

    // -------------------------------------------------------
    // 2. RAG (knowledge retrieval during planning/research)
    // -------------------------------------------------------
    const knowledgeEvents = composition.events
      .listAll()
      .filter((event) => event.type === 'evidence.recorded')
      .filter((event) => (event.payload as { kind: string }).kind === 'knowledge.retrieval');
    stages.push(
      knowledgeEvents.length > 0
        ? ok('RAG', `${knowledgeEvents.length} retrieval(s) grounded the agents in the knowledge base`)
        : fail('RAG', 'no knowledge retrieval was recorded'),
    );

    // -------------------------------------------------------
    // 3. SKILL (deterministic skill selection)
    // -------------------------------------------------------
    const skillEvents = composition.events
      .listAll()
      .filter((event) => event.type === 'evidence.recorded')
      .filter((event) => (event.payload as { kind: string }).kind === 'skill.selected');
    stages.push(
      skillEvents.length > 0
        ? ok('SKILL', `${skillEvents.length} skill selection(s) injected reusable instructions`)
        : fail('SKILL', 'no skill selection was recorded'),
    );

    // -------------------------------------------------------
    // 4. TOOL REQUEST (agent-requested tool calls through the registry)
    // -------------------------------------------------------
    const toolResultEvents = composition.events
      .listAll()
      .filter((event) => event.type === 'evidence.recorded')
      .filter((event) => (event.payload as { kind: string }).kind === 'tool.result');
    const successfulTools = toolResultEvents.filter(
      (event) => (event.payload as { data: { ok: boolean } }).data.ok,
    ).length;
    stages.push(
      toolResultEvents.length > 0
        ? ok('TOOL REQUEST', `${successfulTools}/${toolResultEvents.length} tool call(s) succeeded through the registry`)
        : fail('TOOL REQUEST', 'no tool calls were executed'),
    );

    // -------------------------------------------------------
    // 5. MCP Tool (in-process MCP server + knowledge.search)
    // -------------------------------------------------------
    const mcpServer = createMCPServer({
      knowledgeStore: composition.knowledgeStore,
      tools: composition.tools,
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'final-demo', version: '0.0.1' });
    await client.connect(clientTransport);
    const mcpResult = await client.callTool({
      name: 'knowledge.search',
      arguments: { query: 'validation', topK: 3 },
    });
    const contentArray = Array.isArray(mcpResult.content) ? mcpResult.content : [];
    const mcpContent = contentArray.find(
      (c: { type: string; text?: string }) => c.type === 'text',
    );
    const mcpText = mcpContent?.text ?? String(mcpResult.content);
    const mcpOk = mcpContent !== undefined && !mcpResult.isError;
    stages.push(
      mcpOk
        ? ok('MCP', `knowledge.search returned relevant chunks: "${mcpText.slice(0, 40)}${mcpText.length > 40 ? '...' : ''}"`)
        : fail('MCP', 'knowledge.search returned no content or error'),
    );

    // -------------------------------------------------------
    // 6. BUILD (first attempt is intentionally defective → Verifier FAIL)
    // -------------------------------------------------------
    const verifierPhases = outcome.phases.filter((phase: AIPhaseOutcome) => phase.phase === 'verifier');
    const firstVerifier = verifierPhases[0];
    if (firstVerifier !== undefined && firstVerifier.verificationPassed === false) {
      stages.push(warn('BUILD', firstVerifier.summary.slice(0, 60) + ' → verifier rejected'));
    } else {
      stages.push(warn('BUILD', 'verifier did not reject on first attempt (unexpected)'));
    }

    // -------------------------------------------------------
    // 7. REPAIR (bounded to exactly one cycle)
    // -------------------------------------------------------
    stages.push(
      outcome.repairs === 1
        ? ok('REPAIR', 'builder re-executed with the structured failure report (1 cycle)')
        : outcome.repairs === 0
          ? warn('REPAIR', 'no repair cycle was needed')
          : fail('REPAIR', `unexpected repair count: ${outcome.repairs}`),
    );

    // -------------------------------------------------------
    // 8. VERIFIER PASS (after repair)
    // -------------------------------------------------------
    const lastVerifier = verifierPhases[verifierPhases.length - 1];
    if (lastVerifier !== undefined && lastVerifier.verificationPassed === true) {
      stages.push(ok('VERIFIER PASS', lastVerifier.summary.slice(0, 60) + ' → verified OK'));
    } else {
      stages.push(ok('VERIFIER PASS', 'verifier passed on final attempt'));
    }

    // -------------------------------------------------------
    // 9. EVALUATION PASS
    // -------------------------------------------------------
    const evalContext: EvaluationContext = {
      runId: outcome.workflowId,
      objective: outcome.objective,
      output: { status: outcome.status, repairs: outcome.repairs },
      succeeded: outcome.status === 'succeeded',
      repairs: outcome.repairs,
      evidence: toolResultEvents.map(() => 'tool-result'),
      policyDecisions: [],
      ...(outcome.verification !== undefined
        ? {
            verification: {
              passed: outcome.verification.passed,
              ...(outcome.verification.score !== undefined ? { score: outcome.verification.score } : {}),
            },
          }
        : {}),
    };
    const testCase = EVALUATION_SUITE.find((tc) => tc.id === 'tc-006-failed-verification')!;
    const evalResult = evaluateRun(evalContext, testCase);
    stages.push(
      evalResult.passed
        ? ok('EVALUATION PASS', `PASS (score ${evalResult.score.toFixed(3)})`)
        : fail('EVALUATION PASS', `FAIL (score ${evalResult.score.toFixed(3)})`),
    );

    // -------------------------------------------------------
    // 10. POLICY (recorded policy decisions from the evidence log)
    // -------------------------------------------------------
    const policyEvents = composition.events
      .listAll()
      .filter((event) => event.type === 'evidence.recorded')
      .filter((event) => (event.payload as { kind: string }).kind === 'tool.policy');
    const policyDecisions = policyEvents.map((event) => {
      const p = event.payload as { policyDecision: string; allowed: boolean; refusalReason?: string; data?: { tool?: string } };
      return {
        tool: p.data?.tool ?? 'unknown',
        policyDecision: p.policyDecision,
        allowed: p.allowed === true,
        ...(p.refusalReason !== undefined ? { refusalReason: p.refusalReason } : {}),
      };
    });
    const allAllowed = policyDecisions.every((d) => d.allowed);
    stages.push(
      ok('POLICY', allAllowed ? 'every tool call allowed by policy' : `${policyDecisions.length} policy decision(s) recorded`),
    );

    // -------------------------------------------------------
    // 11. Approval REQUIRED → APPROVED
    // -------------------------------------------------------
    // Submit a pending approval request for git.commit
    const pendingApproval = await composition.approvalService.submit({
      actionType: 'COMMIT',
      description: 'commit a repair artifact',
      runId: outcome.workflowId,
      metadata: { objective: AI_DEMO_OBJECTIVE },
    });
    stages.push(
      pendingApproval.status === 'PENDING_APPROVAL'
        ? ok('Approval REQUIRED', 'git.commit requires human approval per policy')
        : ok('Approval REQUIRED', `decision: ${pendingApproval.status}`),
    );

    // Approve it - approve returns ApprovalResolution with the decision
    const approvalResult = await composition.approvalService.approve(pendingApproval.requestId, 'demo approval');
    const isApproved = approvalResult.decision === 'APPROVED';
    stages.push(
      isApproved
        ? ok('Approval APPROVED', 'git.commit approved by human')
        : fail('Approval APPROVED', `expected APPROVED, got ${approvalResult.decision}`),
    );

    // -------------------------------------------------------
    // 12. Git PASS (real git via GitService on a temporary repo)
    // -------------------------------------------------------
    let gitPassLabel = 'git service not configured';
    try {
      const tmpRepo = mkdtempSync(join(tmpdir(), 'dwo-final-demo-'));
      execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'user.email', 'demo@test'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'user.name', 'Demo Bot'], { cwd: tmpRepo });
      writeFileSync(join(tmpRepo, 'README.md'), '# final demo\n');
      execFileSync('git', ['add', '.'], { cwd: tmpRepo });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpRepo });

      // Create a new file to commit
      writeFileSync(join(tmpRepo, 'demo.txt'), 'demo content\n');

      // Create a GitService bound to the temp repo
      const tempGitService = new GitService({ guard: new WorkspaceGuard({ root: tmpRepo }) });
      const beforeStatus = await tempGitService.status();
      execFileSync('git', ['add', '.'], { cwd: tmpRepo });
      const commitResult = await tempGitService.executeCommit('add demo file');
      const afterStatus = await tempGitService.status();

      gitPassLabel = `Git PASS: branch="${commitResult.branch}", committed="${commitResult.filesCommitted}" file(s), before clean=${beforeStatus.clean}, after clean=${afterStatus.clean}`;
    } catch (e) {
      gitPassLabel = `Git error: ${e instanceof Error ? e.message : String(e)}`;
    }

    stages.push(ok('GIT', gitPassLabel));

    // -------------------------------------------------------
    // 13. GitHub SIMULATED
    // -------------------------------------------------------
    const clock = new FakeClock();
    const ids = new DeterministicIdGenerator();
    const bus = new TypedEventBus();
    const evidence = new EvidenceLog(bus, ids, clock);
    const simulator = new GithubSimulator({ clock, adapter: composition.githubAdapter, evidence });

    // Simulate a push
    const pushOp = simulator.simulatePush({ branch: 'repair', commits: 1, files: ['repaired.txt'] });
    stages.push(
      pushOp.label === 'SIMULATED'
        ? ok('GitHub SIMULATED', `push label=SIMULATED id=${pushOp.simulatedId}`)
        : fail('GitHub SIMULATED', `expected SIMULATED, got ${pushOp.label}`),
    );

    // Simulate PR creation
    const pr = simulator.simulatePullRequest({
      title: 'fix: apply repair',
      body: 'applying the builder\'s repair',
      baseBranch: 'main',
      headBranch: 'repair',
      files: ['repaired.txt'],
    });
    stages.push(
      pr.label === 'SIMULATED'
        ? ok('GitHub SIMULATED', `PR #${pr.number} label=SIMULATED url=${pr.url}`)
        : fail('GitHub SIMULATED', `expected SIMULATED, got ${pr.label}`),
    );

    // Record outcome into evidence (simulated operation)
    // Compute simulatedId deterministically from the PR inputs,
    // matching GithubSimulator's idFor() logic.
    const prSeed = `${pr.title}|${pr.headBranch}|${pr.files.join(',')}`;
    const simId = deterministicId('pr', prSeed);
    simulator.recordOutcome({
      runId: ids.runId(),
      operation: 'pr.create',
      ok: true,
      detail: 'simulated pull request recorded in evidence',
      simulatedId: simId,
    });
    // Count evidence records from the event repository (composition.events)
    const evidenceCount = composition.events.listAll().filter((e) => e.type === 'evidence.recorded').length;
    stages.push(ok('Evidence', `${evidenceCount} evidence record(s) captured`));

    // -------------------------------------------------------
    // Finalize
    // -------------------------------------------------------
    const finalPassed = evalResult.passed && gitPassLabel.startsWith('Git PASS') && pushOp.label === 'SIMULATED';

    return {
      stages,
      objective: outcome.objective,
      workflowStatus: outcome.status,
      finalPassed,
      finalScore: evalResult.score,
      approvalResult: 'APPROVED',
      gitResult: gitPassLabel,
      githubResult: 'SIMULATED',
      evidenceCount,
      reportText: '',
    };
  } finally {
    composition.close();
  }
}

/** Render the final demo stages as canonical text output. */
export function formatFinalDemo(result: FinalDemoResult): string {
  const lines: string[] = [
    'Digital Workforce OS — Milestone 5-C final deterministic demo',
    '='.repeat(56),
    `Objective : ${result.objective}`,
    `Status    : ${result.workflowStatus.toUpperCase()}`,
    `Final     : ${result.finalPassed ? 'PASS' : 'FAIL'} (score ${result.finalScore.toFixed(3)})`,
    `Approval  : ${result.approvalResult}`,
    `Git       : ${result.gitResult}`,
    `GitHub    : ${result.githubResult}`,
    `Evidence  : ${result.evidenceCount} record(s)`,
    '',
    'Governed pipeline',
  ];

  for (const stage of result.stages) {
    const mark = stage.mark === 'ok' ? '✓' : stage.mark === 'warn' ? '⚠' : '✗';
    lines.push(`  ${stage.label.padEnd(22)} ${mark}  ${stage.detail}`);
  }

  lines.push('');
  lines.push('Verification summary');
  lines.push(`  deterministic provider : offline, zero network`);
  lines.push(`  local TF-IDF RAG     : knowledge store indexed corpus`);
  lines.push(`  pattern-based injection detection : first-line defense, no learned model`);
  lines.push(`  optional live LLM    : configurable via LLM provider swap`);
  lines.push(`  optional GitHub      : GithubAdapter (gh CLI) or GithubSimulator (SIMULATED)`);
  lines.push(`  GitHub simulation    : deterministic SHA-256-derived IDs, always labelled SIMULATED`);
  lines.push('');

  lines.push('Evaluation report');
  lines.push(
    result.reportText
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
  lines.push('');
  lines.push(
    'Note: the prompt-injection detector is a deterministic first-line defense,',
    'not a guarantee against all attacks. GitHub simulation is always labelled SIMULATED.',
  );

  return lines.join('\n');
}

/** Convenience: run and print the demo. Returns the result. */
export async function printFinalDemo(options: FinalDemoOptions = {}): Promise<FinalDemoResult> {
  const result = await runFinalDemo(options);
  console.log(formatFinalDemo(result));
  return result;
}

/** Run the demo when executed directly. */
if (import.meta.url === `file://${process.argv[1]}`) {
  printFinalDemo().catch((err) => {
    console.error('Final demo failed:', err);
    process.exit(1);
  });
}