// Broken and unusual files on disk: the walk records them and carries on,
// never hangs and never throws. Real files in a temporary directory, with
// symlinks made at test time.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { appName } from '../dist/esm/node/app-root.js';
import { walkDependencyTree } from '../dist/esm/node/dependency-tree.js';

const WALK = fileURLToPath(
    new URL('../dist/esm/node/dependency-tree.js', import.meta.url),
);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-hostile-')));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/** Builds a tree: strings and buffers are files, `{ symlink }` a link. */
function tree(files) {
    const root = join(base, `tree-${(count += 1)}`);
    mkdirSync(root);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        if (content?.symlink !== undefined) {
            symlinkSync(content.symlink, join(root, path));
        } else {
            writeFileSync(
                join(root, path),
                typeof content === 'string' || Buffer.isBuffer(content)
                    ? content
                    : JSON.stringify(content),
            );
        }
    }

    return root;
}

const app = (dependencies) => ({ name: 'app', version: '1.0.0', dependencies });
const listed = (result) =>
    result.packages.map(({ name, version }) => `${name}@${version}`).sort();

test('a byte order mark is dropped, as Node.js and npm do', async () => {
    const root = tree({
        'package.json': `\uFEFF${JSON.stringify(app({ a: '1.0.0' }))}`,
        'node_modules/a/package.json': '\uFEFF{"name":"a","version":"1.0.0"}',
    });

    const result = await walkDependencyTree(root);

    assert.equal(result.status, 'collected');
    assert.deepEqual(listed(result), ['a@1.0.0']);
    assert.equal(await appName(root), 'app');
});

test('degenerate package files are skipped as invalid_package', async () => {
    const files = {
        empty: '',
        whitespace: ' \n',
        null: 'null',
        array: '[]',
        string: '"a"',
        truncated: '{"name":"t","version":',
        'nul-bytes': '{"name":"n\u0000","version":"1"}\u0000',
        // U+0085, a C1 control the server refuses like any other.
        'c1-control': '{"name":"c1-control","version":"1.0.0\u0085"}',
        'utf-16': Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from('{"name":"u","version":"1"}', 'utf16le'),
        ]),
        'merge-markers':
            '{\n<<<<<<< HEAD\n"name":"m","version":"1"\n=======\n"name":"m","version":"2"\n>>>>>>> main\n}',
    };
    const root = tree({
        'package.json': app(
            Object.fromEntries(
                [...Object.keys(files), 'ms'].map((name) => [name, '1']),
            ),
        ),
        'node_modules/ms/package.json': { name: 'ms', version: '2.1.3' },
        ...Object.fromEntries(
            Object.entries(files).map(([name, content]) => [
                `node_modules/${name}/package.json`,
                content,
            ]),
        ),
    });

    const result = await walkDependencyTree(root);

    assert.equal(result.status, 'partial');
    assert.deepEqual(listed(result), ['ms@2.1.3']);
    assert.deepEqual(
        result.errors.map(({ code, path }) => `${code} ${path}`).sort(),
        Object.keys(files)
            .map((name) => `invalid_package node_modules/${name}/package.json`)
            .sort(),
    );
});

test('a large package file is read like any other: there is no size limit', async () => {
    const root = tree({
        'package.json': app({ big: '1.0.0' }),
        'node_modules/big/package.json': {
            name: 'big',
            version: '1.0.0',
            readme: 'x'.repeat(5 * 1024 * 1024),
        },
    });

    const result = await walkDependencyTree(root);

    assert.equal(result.status, 'collected');
    assert.deepEqual(listed(result), ['big@1.0.0']);
});

test('symlink loops, dangling links and dependency cycles end the walk normally', () => {
    const roots = {
        // a -> b -> a: reading through either link fails with ELOOP.
        mutual: tree({
            'package.json': app({ a: '1', b: '1', ms: '1' }),
            'node_modules/a': { symlink: 'b' },
            'node_modules/b': { symlink: 'a' },
            'node_modules/ms/package.json': { name: 'ms', version: '1' },
        }),
        self: tree({
            'package.json': app({ s: '1' }),
            'node_modules/s': { symlink: 's' },
        }),
        // A link back up the tree: b is then not a package anywhere.
        upward: tree({
            'package.json': app({ a: '1' }),
            'node_modules/a/package.json': {
                name: 'a',
                version: '1',
                dependencies: { b: '1' },
            },
            'node_modules/a/node_modules/b': { symlink: '../..' },
        }),
        dangling: tree({
            'package.json': app({ gone: '1', ms: '1' }),
            'node_modules/gone': { symlink: '../nowhere' },
            'node_modules/ms/package.json': { name: 'ms', version: '1' },
        }),
        cycle: tree({
            'package.json': app({ a: '1' }),
            'node_modules/a/package.json': {
                name: 'a',
                version: '1',
                dependencies: { b: '1' },
            },
            'node_modules/b/package.json': {
                name: 'b',
                version: '1',
                dependencies: { a: '1' },
            },
        }),
    };

    // In a child process, so a loop that hangs or overflows ends the test.
    const child = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import { walkDependencyTree } from ${JSON.stringify(WALK)};
             const roots = ${JSON.stringify(roots)};
             const results = {};
             for (const [name, root] of Object.entries(roots)) {
                 results[name] = await walkDependencyTree(root);
             }
             console.log(JSON.stringify(results));`,
        ],
        { encoding: 'utf8', timeout: 10_000 },
    );

    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout);
    const summary = Object.fromEntries(
        Object.entries(results).map(([name, result]) => [
            name,
            [
                result.status,
                listed(result).join(' '),
                // Reads run in parallel, so errors come in any order.
                result.errors.map(({ code, path }) => `${code} ${path}`).sort(),
            ],
        ]),
    );
    assert.deepEqual(summary, {
        mutual: [
            'partial',
            'ms@1',
            [
                'ELOOP node_modules/a/package.json',
                'ELOOP node_modules/b/package.json',
            ],
        ],
        self: ['partial', '', ['ELOOP node_modules/s/package.json']],
        upward: ['partial', 'a@1', ['unresolved node_modules/a/package.json']],
        // Declared by the app and not installed: partial, no error entry.
        dangling: ['partial', 'ms@1', []],
        cycle: ['collected', 'a@1 b@1', []],
    });
});

test(
    'an unreadable package directory is reported with its error code',
    {
        skip: process.platform === 'win32' || process.getuid?.() === 0,
    },
    async () => {
        const root = tree({
            'package.json': app({ locked: '1', ms: '1' }),
            'node_modules/locked/package.json': {
                name: 'locked',
                version: '1',
            },
            'node_modules/ms/package.json': { name: 'ms', version: '1' },
        });
        chmodSync(join(root, 'node_modules/locked'), 0o000);

        try {
            const result = await walkDependencyTree(root);

            assert.equal(result.status, 'partial');
            assert.deepEqual(listed(result), ['ms@1']);
            assert.deepEqual(result.errors, [
                { code: 'EACCES', path: 'node_modules/locked/package.json' },
            ]);
        } finally {
            chmodSync(join(root, 'node_modules/locked'), 0o755);
        }
    },
);
