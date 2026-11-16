// Builds dist/esm and dist/cjs with tsc. dist/cjs gets its own package.json
// marking it CommonJS, because the package itself is `"type": "module"`, and
// both builds get the package's version in place of the placeholder.

import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = "'0.0.0-development'";
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });

for (const project of ['tsconfig.esm.json', 'tsconfig.cjs.json']) {
    execFileSync('tsc', ['-p', project], { stdio: 'inherit' });
}

writeFileSync('dist/cjs/package.json', '{ "type": "commonjs" }\n');

// The reporter sends its own version; it comes from package.json.
for (const file of ['dist/esm/core/version.js', 'dist/cjs/core/version.js']) {
    const built = readFileSync(file, 'utf8');
    if (!built.includes(PLACEHOLDER)) {
        throw new Error(`${file} has no version placeholder`);
    }
    writeFileSync(file, built.replace(PLACEHOLDER, JSON.stringify(version)));
}
chmodSync('dist/cjs/cli.js', 0o755);
