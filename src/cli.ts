import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createComposition } from './index.js';
import { TaskGraph, createTask } from './graph/task-graph.js';
import { RandomIdGenerator, SystemClock } from './core/types.js';
import {
  AI_DEMO_OBJECTIVE,
  createDemoResponses,
} from './orchestrator/ai-demo.js';
import type { AIWorkflowOutcome, AIPhaseOutcome } from './orchestrator/ai-workflow.js';

export interface CliOptions {
  dbPath: string;
  concurrency: number;
  failFast: boolean;
  verbose: boolean;
  json: boolean;
  /** Run the Milestone 2 AI workflow demo instead of the M1 graph demo. */
  ai: boolean;
}

const DEFAULTS: CliOptions = {
  dbPath: join('data', 'demo.db'),
  concurrency: 2,
  failFast: true,
  verbose: false,
  json: false,
  ai: false,
};

/** Minimal, dependency-free argument parsing. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--db') {
      options.dbPath = argv[i + 1] as string;
      i++;
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Number(argv[i + 1]) || DEFAULTS.concurrency);
      i++;
    } else if (arg === '--continue') {
      options.failFast = false;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--ai') {
      options.ai = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Digital Workforce OS — demo CLI

Usage: pnpm demo [options]

Options:
  --db <path>          SQLite database path (default: data/demo.db)
  --concurrency <n>    Max concurrent tasks (default: 2)
  --continue           Keep running independent tasks after a failure
  --verbose            Print every persisted event
  --json               Print machine-readable JSON summary
  --ai                 Run the Milestone 2 AI workflow demo
                       (planner -> researcher -> builder -> verifier,
                       with one automatic repair cycle; fully offline)
  --help               Show this help`);
}

/** The canonical Milestone 1 sample workflow: research -> implementation -> verification. */
export function buildDemoGraph(): TaskGraph {
  const ids = new RandomIdGenerator();
  const graph = new TaskGraph();

  const research = createTask(ids.taskId(), 'research', 'deterministic', {
    capability: 'research',
    input: {
      topic: 'SQLite WAL mode',
      tool: 'word_count',
      args: {
        text: 'Write-ahead logging enables concurrent readers while a write transaction is in progress.',
      },
    },
  });

  const implementation = createTask(ids.taskId(), 'implementation', 'deterministic', {
    capability: 'implementation',
    dependsOn: [research.id],
    input: {
      topic: 'task graph scheduler',
      notes: 'Implement dependency-aware scheduling with a concurrency limit.',
    },
  });

  const verification = createTask(ids.taskId(), 'verification', 'deterministic', {
    capability: 'verification',
    dependsOn: [implementation.id],
    input: {
      topic: 'end-to-end correctness',
      tool: 'calculator',
      args: { operation: 'add', a: 2, b: 3 },
    },
  });

  graph.addTask(research);
  graph.addTask(implementation);
  graph.addTask(verification);
  return graph;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const directory = join(options.dbPath, '..');
  if (directory && directory !== '.') {
    mkdirSync(directory, { recursive: true });
  }

  if (options.ai) {
    await runAiDemo(options);
    return;
  }

  await runGraphDemo(options);
}

/** The Milestone 2 AI workflow demo: fully offline, deterministic. */
async function runAiDemo(options: CliOptions): Promise<void> {
  const composition = createComposition({
    dbPath: options.dbPath,
    concurrency: options.concurrency,
    ids: new RandomIdGenerator(),
    clock: new SystemClock(),
    // Scripted, intent-keyed responses keep the demo
    // deterministic with zero network access.
    llmResponses: createDemoResponses(),
  });

  try {
    const outcome = await composition.ai.run(AI_DEMO_OBJECTIVE);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            workflowId: outcome.workflowId,
            objective: outcome.objective,
            status: outcome.status,
            repairs: outcome.repairs,
            phases: outcome.phases.map((phase) => ({
              label: phase.label,
              agent: phase.agent,
              status: phase.status,
              verificationPassed: phase.verificationPassed,
            })),
            runs: outcome.runs.length,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('Digital Workforce OS — Milestone 2 AI workflow demo');
    console.log('='.repeat(52));
    console.log(`Objective : ${outcome.objective}`);
    console.log(
      `Provider  : ${composition.llm.name} (model: ${composition.llm.model.name}) [offline]`,
    );
    console.log(`Workflow  : ${outcome.workflowId}`);
    console.log();
    console.log('Phases');
    for (const phase of outcome.phases) {
      console.log(`  ${formatPhaseLine(phase)}`);
    }
    console.log(`  ${'Final'.padEnd(14)} ${outcome.status === 'succeeded' ? 'SUCCESS' : 'FAILURE'}`);
    console.log();
    console.log(
      `Repairs     : ${outcome.repairs} automatic repair cycle${outcome.repairs === 1 ? '' : 's'}`,
    );
    if (outcome.verification !== undefined) {
      console.log(
        `Verification: ${outcome.verification.passed ? 'passed' : 'failed'} (score ${outcome.verification.score ?? 'n/a'})`,
      );
    }
    console.log(`Duration    : ${outcome.durationMs}ms`);

    // Prove persistence: read everything back from SQLite.
    const runs = composition.runs.list();
    const eventsForWorkflow = composition.events.countByRun(
      outcome.workflowId,
    );
    console.log();
    console.log('Persistence (read back from SQLite)');
    console.log(`  runs      : ${runs.length} total (planner, main, repairs)`);
    console.log(
      `  workflow  : ${eventsForWorkflow} evidence records under the workflow id`,
    );
    for (const run of outcome.runs) {
      const taskRows = composition.tasks.listByRun(run.runId);
      const eventCount = composition.events.countByRun(run.runId);
      console.log(
        `  run       : ${run.runName} -> ${run.status}, ${taskRows.length} tasks, ${eventCount} events`,
      );
    }
    if (options.verbose) {
      console.log();
      console.log('Evidence kinds (workflow scope)');
      const kinds = new Map<string, number>();
      for (const event of composition.events.listByRun(
        outcome.workflowId,
      )) {
        if (event.type !== 'evidence.recorded') continue;
        const payload = event.payload as { kind: string };
        kinds.set(payload.kind, (kinds.get(payload.kind) ?? 0) + 1);
      }
      for (const [kind, count] of [...kinds.entries()].sort()) {
        console.log(`  ${kind.padEnd(24)} x${count}`);
      }
    }
  } finally {
    composition.close();
  }
}

/** One display line for a workflow phase. */
function formatPhaseLine(phase: AIPhaseOutcome): string {
  let mark: string;
  if (phase.status === 'failed') {
    mark = '✗';
  } else if (phase.phase === 'verifier' && phase.verificationPassed === false) {
    // The verifier ran successfully but rejected the work.
    mark = '⚠';
  } else {
    mark = '✓';
  }
  const detail = phase.summary.length > 58 ? `${phase.summary.slice(0, 55)}...` : phase.summary;
  return `${phase.label.padEnd(14)} ${mark}  ${detail}`;
}

/** The canonical Milestone 1 graph demo. */
async function runGraphDemo(options: CliOptions): Promise<void> {
  const composition = createComposition({
    dbPath: options.dbPath,
    concurrency: options.concurrency,
    failFast: options.failFast,
    ids: new RandomIdGenerator(),
    clock: new SystemClock(),
  });

  try {
    const graph = buildDemoGraph();
    const handle = composition.orchestrator.start(graph, 'demo-run');
    const outcome = await handle.promise;

    if (options.json) {
      const persisted = {
        runs: composition.runs.list().length,
        tasks: composition.tasks.listByRun(outcome.runId).length,
        events: composition.events.countByRun(outcome.runId),
      };
      console.log(JSON.stringify({ outcome, persisted }, null, 2));
      return;
    }

    console.log('Digital Workforce OS — Milestone 1 demo');
    console.log('='.repeat(52));
    console.log(`Database : ${options.dbPath} (SQLite, WAL mode)`);
    console.log(`Run      : ${outcome.runId}  (${outcome.runName})`);
    console.log(`Concurrency: ${options.concurrency}`);
    console.log();
    console.log('Tasks');
    for (const task of outcome.tasks) {
      const mark = task.status === 'succeeded' ? '✓' : task.status === 'failed' ? '✗' : '⊘';
      console.log(
        `  ${mark} ${task.taskName.padEnd(16)} ${task.status.padEnd(10)} attempt ${task.attempts}  ${task.durationMs}ms`,
      );
      if (task.output !== undefined) {
        const summary = JSON.stringify(task.output);
        console.log(`      ${summary.length > 110 ? `${summary.slice(0, 107)}...` : summary}`);
      }
      if (task.error !== undefined) {
        console.log(`      error: ${task.error}`);
      }
    }
    console.log();
    console.log(
      `Run status: ${outcome.status.toUpperCase()} in ${outcome.durationMs}ms`,
    );
    console.log(
      `Tasks: ${outcome.succeeded} succeeded, ${outcome.failed} failed, ${outcome.cancelled} cancelled, ${outcome.skipped} skipped`,
    );

    // Prove persistence: read everything back from SQLite.
    const runRow = composition.runs.get(outcome.runId);
    const taskRows = composition.tasks.listByRun(outcome.runId);
    const eventCount = composition.events.countByRun(outcome.runId);
    console.log();
    console.log('Persistence (read back from SQLite)');
    console.log(`  runs   : ${composition.runs.list().length} total, this run status = ${runRow?.status}`);
    console.log(`  tasks  : ${taskRows.length} persisted for this run`);
    console.log(`  events : ${eventCount} persisted for this run`);
    if (options.verbose) {
      console.log();
      console.log('Events');
      for (const event of composition.events.listByRun(outcome.runId)) {
        const task = event.taskId !== undefined ? ` [${event.taskId}]` : '';
        console.log(`  ${event.type}${task} ${event.occurredAt}`);
      }
    }
  } finally {
    composition.close();
  }
}

main().catch((error: unknown) => {
  console.error('Demo failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
