import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc does not copy non-TS assets; the migrations SQL file must reach dist/
// so the compiled build can load it via import.meta.url.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'src', 'persistence', 'migrations', '0001_init.sql');
const target = join(root, 'dist', 'persistence', 'migrations', '0001_init.sql');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`Copied ${source} -> ${target}`);
