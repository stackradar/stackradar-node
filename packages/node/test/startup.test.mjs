// What init() loads on the app's start-up path: configuration and the
// reporter only. The collection and sending code, and node:https with it,
// load when the reporter starts, seconds later.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const dist = (path) => new URL(`../dist/${path}`, import.meta.url);

/** Runs `code` in a new process; it prints JSON on its last line. */
function run(args, code) {
    const child = spawnSync(process.execPath, [...args, '-e', code], {
        encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);

    return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

const https = (list) => list.includes('NativeModule https');

test('the CommonJS build: init() loads neither the collection code nor node:https', () => {
    const result = run(
        [],
        `require(${JSON.stringify(fileURLToPath(dist('cjs/index.js')))}).init({ ingestKey: '${KEY}' });
         const files = Object.keys(require.cache);
         const builtins = [...process.moduleLoadList];
         require(${JSON.stringify(fileURLToPath(dist('cjs/node/start.js')))});
         console.log(JSON.stringify({ files, builtins, after: process.moduleLoadList }));`,
    );

    assert.deepEqual(
        result.files.filter((file) =>
            /[/\\]node[/\\](start|transport|dependency-tree|yarn-pnp|packages)\.js$/.test(
                file,
            ),
        ),
        [],
    );
    assert.equal(https(result.builtins), false);
    // The check would see it: loading the collection code loads node:https.
    assert.equal(https(result.after), true);
});

test('the ESM build: init() does not load node:https', () => {
    const result = run(
        ['--input-type=module'],
        `const { init } = await import(${JSON.stringify(dist('esm/index.js').href)});
         init({ ingestKey: '${KEY}' });
         const builtins = [...process.moduleLoadList];
         await import(${JSON.stringify(dist('esm/node/start.js').href)});
         console.log(JSON.stringify({ builtins, after: process.moduleLoadList }));`,
    );

    assert.equal(https(result.builtins), false);
    assert.equal(https(result.after), true);
});
