// Standalone persistence verification for the Milestone 1 demo database.
import Database from 'better-sqlite3';

const db = new Database('data/demo.db', { readonly: true });

console.log('journal_mode :', db.pragma('journal_mode', { simple: true }));
console.log('foreign_keys :', db.pragma('foreign_keys', { simple: true }));

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  .all()
  .map((row) => row.name);
console.log('tables       :', tables.join(', '));

const runs = db
  .prepare(`SELECT id, name, status, started_at, completed_at, updated_at FROM runs ORDER BY created_at`)
  .all();
for (const run of runs) {
  console.log(
    `run ${run.name} -> ${run.status} (started=${run.started_at !== null}, completed=${run.completed_at !== null})`,
  );
}

const tasks = db
  .prepare(`SELECT task_name, status, attempts, output FROM tasks ORDER BY created_at`)
  .all();
for (const task of tasks) {
  const output = JSON.parse(task.output);
  console.log(
    `task ${task.task_name.padEnd(16)} ${task.status.padEnd(9)} attempts=${task.attempts} output.keys=${Object.keys(output).join(',')}`,
  );
}

const eventTypes = db
  .prepare(`SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC`)
  .all();
console.log('event types  :', eventTypes.map((row) => `${row.type}(${row.n})`).join(' '));

const evidence = db
  .prepare(`SELECT payload FROM events WHERE type = 'evidence.recorded' ORDER BY seq`)
  .all()
  .map((row) => JSON.parse(row.payload));
const validHashes = evidence.every((row) => /^[a-f0-9]{64}$/.test(row.hash));
console.log(`evidence     : ${evidence.length} records, all SHA-256 hashes valid: ${validHashes}`);

const seqs = db.prepare(`SELECT seq FROM events ORDER BY seq`).all().map((row) => row.seq);
console.log('event seqs   : strictly increasing =', seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]));

db.close();
