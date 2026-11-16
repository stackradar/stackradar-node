// Misconfiguration never affects the host process: each case runs a real
// child process and checks its exit code, its output and that it exits at
// once, so the reporter's start timer keeps nothing alive.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/** Runs CommonJS code that resolves `@stackradar/node` through the package's own exports. */
function runApp(code, { env = {}, args = [] } = {}) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [...args, '-e', code], {
        cwd: packageDirectory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
        timeout: 10_000,
    });

    return { ...result, milliseconds: Date.now() - startedAt };
}

const APP = "require('@stackradar/node').init(OPTIONS); console.log('app ok');";
const app = (options = 'undefined') => APP.replace('OPTIONS', options);

test('without an Ingest Key the app runs untouched and silent', () => {
    const result = runApp(app());

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'app ok\n');
    assert.equal(result.stderr, '');
});

test('an invalid Ingest Key costs the app one stderr line and never shows the key', () => {
    const result = runApp(app(), {
        env: { STACKRADAR_INGEST_KEY: 'sr_ingest_secret-but-wrong' },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'app ok\n');
    assert.match(
        result.stderr,
        /^@stackradar\/node: the Ingest Key from STACKRADAR_INGEST_KEY is not valid[^\n]*\n$/,
    );
    assert.ok(!result.stderr.includes('secret'));
});

test('unusable options cost the app one stderr line', () => {
    const result = runApp(app("{ service: 42, servce: 'api' }"), {
        env: { STACKRADAR_INGEST_KEY: KEY },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'app ok\n');
    assert.equal(result.stderr.split('\n').filter(Boolean).length, 1);
});

test('a configured reporter does not keep the process alive', () => {
    const result = runApp(app(), { env: { STACKRADAR_INGEST_KEY: KEY } });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'app ok\n');
    assert.equal(result.stderr, '');
    assert.ok(result.milliseconds < 4_000, `took ${result.milliseconds} ms`);
});

test('register and a later init() share one reporter across the CommonJS and ESM builds', () => {
    const result = spawnSync(
        process.execPath,
        [
            '--require',
            '@stackradar/node/register',
            '--input-type=module',
            '-e',
            "import { init } from '@stackradar/node'; init({ service: 'api' });",
        ],
        {
            cwd: packageDirectory,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                STACKRADAR_INGEST_KEY: KEY,
                STACKRADAR_DEBUG: '1',
            },
            timeout: 10_000,
        },
    );

    assert.equal(result.status, 0);
    assert.match(
        result.stderr,
        /init\(\) was called again before the reporter started; options merged/,
    );
    assert.match(result.stderr, /configured: [^\n]*service=api/);
    assert.ok(!result.stderr.includes(KEY));
});

test('worker threads loaded through NODE_OPTIONS add no reporters', () => {
    const result = spawnSync(
        process.execPath,
        [
            '-e',
            `const { Worker } = require('node:worker_threads');
             for (let i = 0; i < 3; i++) {
                 new Worker("require('@stackradar/node').init()", { eval: true });
             }`,
        ],
        {
            cwd: packageDirectory,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                NODE_OPTIONS: '--require @stackradar/node/register',
                STACKRADAR_INGEST_KEY: KEY,
                STACKRADAR_DEBUG: '1',
            },
            timeout: 10_000,
        },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr.match(/configured: /g)?.length, 1);
});

test('a closed stderr pipe never takes the app down', async () => {
    // The pipe is closed before the reporter writes its warning, so the
    // write fails with EPIPE.
    const child = spawn(
        process.execPath,
        [
            '-e',
            "require('@stackradar/node').init(); setTimeout(() => console.log('app ok'), 300);",
        ],
        {
            cwd: packageDirectory,
            env: { PATH: process.env.PATH, STACKRADAR_INGEST_KEY: 'wrong' },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    child.stderr.destroy();

    let stdout = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    const [code] = await new Promise((resolve) =>
        child.on('close', (...result) => resolve(result)),
    );

    assert.equal(code, 0);
    assert.equal(stdout, 'app ok\n');
});
