// Fails when @stackradar/node declares any runtime dependency. The reporter
// runs inside customers' production processes and uses only `node:`
// built-ins, so everything it needs must be a dev dependency.

import { readFileSync } from 'node:fs';

const MANIFEST = 'packages/node/package.json';
const FIELDS = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
];

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const declared = FIELDS.flatMap((field) => {
    const value = manifest[field];
    const names = Array.isArray(value) ? value : Object.keys(value ?? {});

    return names.map((name) => `${field}: ${name}`);
});

if (declared.length > 0) {
    console.error(
        `${MANIFEST} must have no runtime dependencies:\n${declared.join('\n')}`,
    );
    process.exitCode = 1;
} else {
    console.log(`${MANIFEST} has no runtime dependencies.`);
}
