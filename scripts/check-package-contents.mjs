// Fails when the packed package would contain anything besides the build,
// its manifest, README and LICENSE, so a stray file can never be published.

import { execFileSync } from 'node:child_process';

const ALLOWED = /^(dist\/.+|package\.json|README\.md|LICENSE)$/;

const [{ files }] = JSON.parse(
    execFileSync(
        'npm',
        ['pack', '--dry-run', '--json', '--workspace', 'packages/node'],
        { encoding: 'utf8' },
    ),
);
const unexpected = files
    .map(({ path }) => path)
    .filter((path) => !ALLOWED.test(path));

if (unexpected.length > 0) {
    console.error(`Not expected in the package:\n${unexpected.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`${files.length} files, all expected.`);
}
