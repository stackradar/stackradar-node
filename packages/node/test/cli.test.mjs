// Runs the built `stackradar-node` command with the Node.js under test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cjs/cli.js', import.meta.url));
const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('--version prints the package version', () => {
    const { version } = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const result = run('--version');

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
});

test('--help prints the usage', () => {
    const result = run('--help');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: stackradar-node <command>/);
});

test('an unknown command prints the usage and fails', () => {
    const result = run('unknown');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Unknown command: unknown\n/);
});
