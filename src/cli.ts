import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createComposition } from './index.js';
import { TaskGraph, createTask } from './graph/task-graph.js';
import { RandomIdGenerator, SystemClock } from './core/types.js';

export interface CliOptions {
  dbPath: string;
  concurrency: number;
  failFast: boolean;
  verbose: boolean;
  json: boolean;
}

const DEFAULTS: CliOptions = {
  dbPath: join('data', 'demo.db'),
  concurrency: 2,
  failFast: true,
  verbose: false,
  json: false,
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
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Digital Workforce OS — Milestone 1 demo

Usage: pnpm demo [options]

Options:
  --db <path>          SQLite database path (default: data/demo.db)
  --concurrency <n>    Max concurrent tasks (default: 2)
  --continue           Keep running independent tasks after a failure
  --verbose            Print every persisted event
  --json               Print machine-readable JSON summary
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
