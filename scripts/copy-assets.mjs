import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc does not copy non-TS assets; the migrations SQL files must
// reach dist/ so the compiled build can load them via
// import.meta.url.
//
// Every *.sql in the migrations directory is copied, so adding a
// migration does not require updating this script.
const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'src', 'persistence', 'migrations');
const targetDir = join(root, 'dist', 'persistence', 'migrations');

mkdirSync(targetDir, { recursive: true });

const migrations = readdirSync(sourceDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (migrations.length === 0) {
  console.error(`No migration SQL files found in ${sourceDir}`);
  process.exit(1);
}

for (const name of migrations) {
  const source = join(sourceDir, name);
  const target = join(targetDir, name);
  copyFileSync(source, target);
  console.log(`Copied ${source} -> ${target}`);
}