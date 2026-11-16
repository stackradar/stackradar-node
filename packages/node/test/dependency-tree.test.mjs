// The dependency-tree detector on small hand-built trees, one rule at
// a time. Real installs are covered by the fixture tests.

import assert from 'node:assert/strict';
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
import { dirname, join, posix, win32 } from 'node:path';
import { after, test } from 'node:test';

import {
    pathFromRoot,
    walkDependencyTree,
} from '../dist/esm/node/dependency-tree.js';
import { collectPackages } from '../dist/esm/node/packages.js';
import { inventoryHash } from '../dist/esm/core/inventory.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-tree-')));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/** Builds a tree: string or object values are files, `{ symlink }` a link. */
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
                typeof content === 'string' ? content : JSON.stringify(content),
            );
        }
    }

    return root;
}

const pkg = (name, version, fields = {}) => ({ name, version, ...fields });
const sorted = (packages) =>
    packages.map(({ name, version }) => `${name}@${version}`).sort();

test('a hoisted tree with a nested second version lists both', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: { a: '1.0.0', b: '1.0.0' },
            devDependencies: { dev: '1.0.0' },
        }),
        'node_modules/a/package.json': pkg('a', '1.0.0', {
            dependencies: { b: '^2.0.0' },
        }),
        'node_modules/a/node_modules/b/package.json': pkg('b', '2.0.0'),
        'node_modules/b/package.json': pkg('b', '1.0.0'),
        'node_modules/dev/package.json': pkg('dev', '1.0.0'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'a@1.0.0',
        'b@1.0.0',
        'b@2.0.0',
    ]);
    assert.deepEqual(result.errors, []);
});

test('an npm: alias is listed under the installed package name', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: { 'my-colors': 'npm:picocolors@1.1.1' },
        }),
        'node_modules/my-colors/package.json': pkg('picocolors', '1.1.1'),
    });

    assert.deepEqual(sorted((await walkDependencyTree(app)).packages), [
        'picocolors@1.1.1',
    ]);
});

test('an optional dependency that is not installed is left out, silently', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: { a: '1.0.0' },
            optionalDependencies: { fsevents: '2.3.3', kleur: '4.1.5' },
        }),
        'node_modules/a/package.json': pkg('a', '1.0.0', {
            optionalDependencies: { missing: '1.0.0' },
        }),
        'node_modules/kleur/package.json': pkg('kleur', '4.1.5'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['a@1.0.0', 'kleur@4.1.5']);
    assert.deepEqual(result.errors, []);
});

test('a missing dependency the app declares makes the list partial', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: { a: '1.0.0', bundled: '1.0.0' },
        }),
        'node_modules/a/package.json': pkg('a', '1.0.0'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'partial');
    assert.equal(result.declaredMissing, true);
    assert.deepEqual(sorted(result.packages), ['a@1.0.0']);
});

test('a missing transitive dependency makes the list partial and names the package', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', { dependencies: { a: '1.0.0' } }),
        'node_modules/a/package.json': pkg('a', '1.0.0', {
            dependencies: { gone: '1.0.0' },
        }),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'partial');
    assert.equal(result.declaredMissing, false);
    assert.deepEqual(result.errors, [
        { code: 'unresolved', path: 'node_modules/a/package.json' },
    ]);
});

test('required peers are followed; optional and missing peers are not', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', { dependencies: { a: '1.0.0' } }),
        'node_modules/a/package.json': pkg('a', '1.0.0', {
            peerDependencies: { react: '*', typescript: '*', missing: '*' },
            peerDependenciesMeta: { typescript: { optional: true } },
        }),
        'node_modules/react/package.json': pkg('react', '19.0.0'),
        'node_modules/typescript/package.json': pkg('typescript', '5.6.3'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['a@1.0.0', 'react@19.0.0']);
});

test('workspace and local packages are skipped and their dependencies followed', async () => {
    const repo = tree({
        'apps/api/package.json': pkg('api', '1.0.0', {
            dependencies: {
                shared: 'workspace:*',
                tools: 'file:../../packages/tools',
            },
        }),
        'apps/api/node_modules/shared': { symlink: '../../../packages/shared' },
        'apps/api/node_modules/tools': { symlink: '../../../packages/tools' },
        'packages/shared/package.json': pkg('@acme/shared', '1.0.0', {
            dependencies: { ms: '2.1.3' },
        }),
        'packages/tools/package.json': pkg('@acme/tools', '1.0.0'),
        'node_modules/ms/package.json': pkg('ms', '2.1.3'),
    });

    const result = await walkDependencyTree(join(repo, 'apps/api'));

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['ms@2.1.3']);
});

test('a package copied into node_modules but asked for with workspace: is still skipped', async () => {
    // pnpm deploy copies workspace packages into node_modules.
    const app = tree({
        'package.json': pkg('api', '1.0.0', {
            dependencies: { '@acme/shared': 'workspace:*' },
        }),
        'node_modules/@acme/shared/package.json': pkg('@acme/shared', '1.0.0', {
            dependencies: { ms: '2.1.3' },
        }),
        'node_modules/ms/package.json': pkg('ms', '2.1.3'),
    });

    assert.deepEqual(sorted((await walkDependencyTree(app)).packages), [
        'ms@2.1.3',
    ]);
});

test("pnpm deploy's aliased file: form marks a workspace package", async () => {
    // pnpm deploy rewrites workspace:* to <name>@file:<path> and copies the
    // package into node_modules/.pnpm.
    const app = tree({
        'package.json': pkg('api', '1.0.0', {
            dependencies: {
                '@acme/shared': '@acme/shared@file:///w/packages/shared',
            },
        }),
        'node_modules/@acme/shared': {
            symlink: '../.pnpm/@acme+shared@file+w/node_modules/@acme/shared',
        },
        'node_modules/.pnpm/@acme+shared@file+w/node_modules/@acme/shared/package.json':
            pkg('@acme/shared', '1.0.0', { dependencies: { ms: '2.1.3' } }),
        'node_modules/.pnpm/@acme+shared@file+w/node_modules/ms/package.json':
            pkg('ms', '2.1.3'),
    });

    assert.deepEqual(sorted((await walkDependencyTree(app)).packages), [
        'ms@2.1.3',
    ]);
});

test('a symlinked store layout resolves from each package real path', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', { dependencies: { a: '1.0.0' } }),
        'node_modules/a': { symlink: '.pnpm/a@1.0.0/node_modules/a' },
        'node_modules/.pnpm/a@1.0.0/node_modules/a/package.json': pkg(
            'a',
            '1.0.0',
            {
                dependencies: { b: '2.0.0' },
            },
        ),
        'node_modules/.pnpm/a@1.0.0/node_modules/b': {
            symlink: '../../b@2.0.0/node_modules/b',
        },
        'node_modules/.pnpm/b@2.0.0/node_modules/b/package.json': pkg(
            'b',
            '2.0.0',
        ),
        // Hoisted into the store's node_modules, never reached by the app.
        'node_modules/.pnpm/node_modules/b/package.json': pkg('b', '9.9.9'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['a@1.0.0', 'b@2.0.0']);
});

test('a package asked for by git URL is skipped and its dependencies followed', async () => {
    const gitSpecs = {
        https: 'https://github.com/acme/https.git',
        page: 'https://github.com/acme/page#v1',
        scp: 'git@github.com:acme/scp.git',
        selfhosted: 'https://git.example.com/acme/selfhosted.git',
        ssh: 'ssh://git@git.example.com/acme/ssh.git',
        plus: 'git+https://git.example.com/acme/plus.git',
        short: 'acme/short',
    };
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: {
                ...gitSpecs,
                tarball:
                    'https://registry.example.com/tarball/-/tarball-1.0.0.tgz',
                archive: 'https://github.com/acme/archive/archive/v1.tar.gz',
            },
        }),
        ...Object.fromEntries(
            Object.keys(gitSpecs).map((name) => [
                `node_modules/${name}/package.json`,
                // Each claims a registry name and version it did not come from.
                pkg(name, '1.0.0', {
                    dependencies: { [`${name}-dep`]: '1.0.0' },
                }),
            ]),
        ),
        ...Object.fromEntries(
            Object.keys(gitSpecs).map((name) => [
                `node_modules/${name}-dep/package.json`,
                pkg(`${name}-dep`, '1.0.0'),
            ]),
        ),
        'node_modules/tarball/package.json': pkg('tarball', '1.0.0'),
        'node_modules/archive/package.json': pkg('archive', '1.0.0'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'archive@1.0.0',
        'https-dep@1.0.0',
        'page-dep@1.0.0',
        'plus-dep@1.0.0',
        'scp-dep@1.0.0',
        'selfhosted-dep@1.0.0',
        'short-dep@1.0.0',
        'ssh-dep@1.0.0',
        'tarball@1.0.0',
    ]);
});

test('unusable package files are skipped with an error, and the list is partial; bad names are never resolved', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: {
                broken: '1.0.0',
                nameless: '1.0.0',
                control: '1.0.0',
                '../../escape': '1.0.0',
                ms: '2.1.3',
            },
        }),
        'node_modules/ms/package.json': pkg('ms', '2.1.3'),
        'node_modules/broken/package.json': '{ not json',
        'node_modules/nameless/package.json': { version: '1.0.0' },
        'node_modules/control/package.json': pkg('control', '1.0.0\n'),
        'escape/package.json': pkg('escape', '1.0.0'),
    });

    const result = await walkDependencyTree(app);

    assert.equal(result.status, 'partial');
    assert.deepEqual(sorted(result.packages), ['ms@2.1.3']);
    assert.deepEqual(
        result.errors.map(({ code, path }) => `${code} ${path}`).sort(),
        [
            'invalid_package node_modules/broken/package.json',
            'invalid_package node_modules/control/package.json',
            'invalid_package node_modules/nameless/package.json',
        ],
    );
    const { section } = await collectPackages(app, {});
    assert.equal(section.status, 'partial');
    assert.equal(section.errors.length, 3);
});

test(
    'an unreadable package file is reported with its error code, and the list is partial',
    {
        skip: process.platform === 'win32' || process.getuid?.() === 0,
    },
    async () => {
        const app = tree({
            'package.json': pkg('app', '1.0.0', {
                dependencies: { locked: '1.0.0', ms: '2.1.3' },
            }),
            'node_modules/locked/package.json': pkg('locked', '1.0.0'),
            'node_modules/ms/package.json': pkg('ms', '2.1.3'),
        });
        chmodSync(join(app, 'node_modules/locked/package.json'), 0o000);

        try {
            const result = await walkDependencyTree(app);

            assert.equal(result.status, 'partial');
            assert.deepEqual(sorted(result.packages), ['ms@2.1.3']);
            assert.deepEqual(result.errors, [
                { code: 'EACCES', path: 'node_modules/locked/package.json' },
            ]);
            // The packages section says the same.
            const { section } = await collectPackages(app, {});
            assert.equal(section.status, 'partial');
            assert.deepEqual(section.errors, result.errors);
        } finally {
            chmodSync(join(app, 'node_modules/locked/package.json'), 0o644);
        }
    },
);

test('the package and time limits make the walk fail without a list', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', {
            dependencies: { a: '1', b: '1', c: '1' },
        }),
        'node_modules/a/package.json': pkg('a', '1'),
        'node_modules/b/package.json': pkg('b', '1'),
        'node_modules/c/package.json': pkg('c', '1'),
    });

    const tooMany = await walkDependencyTree(app, {
        maxPackages: 2,
        milliseconds: 5_000,
        concurrency: 8,
    });
    let clock = 0;
    const slow = await walkDependencyTree(
        app,
        { maxPackages: 10_000, milliseconds: 5_000, concurrency: 1 },
        () => (clock += 3_000),
    );

    assert.deepEqual([tooMany.status, tooMany.packages], ['failed', []]);
    assert.equal(tooMany.errors[0].code, 'too_many_packages');
    assert.deepEqual([slow.status, slow.packages], ['failed', []]);
    assert.equal(slow.errors[0].code, 'timeout');
});

test('the packages section: hash, bundled apps, nothing found and failures', async () => {
    const app = tree({
        'package.json': pkg('app', '1.0.0', { dependencies: { a: '1.0.0' } }),
        'node_modules/a/package.json': pkg('a', '1.0.0'),
    });
    const bundled = tree({
        'package.json': pkg('web', '1.0.0', {
            dependencies: { next: '16.0.0' },
        }),
    });

    const collected = await collectPackages(app, {});
    assert.deepEqual(collected.section, {
        detector: 'dependency-tree',
        status: 'collected',
        ecosystem: 'npm',
        inventory_hash: inventoryHash('npm', [{ name: 'a', version: '1.0.0' }]),
    });
    assert.deepEqual(collected.packages, [{ name: 'a', version: '1.0.0' }]);

    const standalone = await collectPackages(app, {
        __NEXT_PRIVATE_STANDALONE_CONFIG: '{}',
    });
    assert.equal(standalone.section.status, 'partial');
    assert.deepEqual(standalone.section.errors, [{ code: 'bundled_app' }]);

    assert.deepEqual((await collectPackages(bundled, {})).section, {
        detector: 'dependency-tree',
        status: 'not_found',
        ecosystem: null,
        inventory_hash: null,
        errors: [{ code: 'bundled_app' }],
    });

    assert.deepEqual((await collectPackages(null, {})).section, {
        detector: 'none',
        status: 'not_found',
        ecosystem: null,
        inventory_hash: null,
    });
    assert.equal(
        (await collectPackages(join(base, 'no-such-app'), {})).section.detector,
        'none',
    );

    const failed = await collectPackages(
        app,
        {},
        { limits: { maxPackages: 0, milliseconds: 5_000, concurrency: 8 } },
    );
    assert.deepEqual(failed.section, {
        detector: 'dependency-tree',
        status: 'failed',
        ecosystem: null,
        inventory_hash: null,
        errors: [{ code: 'too_many_packages' }],
    });
    assert.equal(failed.packages, null);
});

test('error paths are relative to the app root, and left out when Windows has none', () => {
    assert.equal(
        pathFromRoot('/srv/app', '/srv/app/node_modules/a/package.json', posix),
        'node_modules/a/package.json',
    );
    assert.equal(
        pathFromRoot('/srv/app', '/srv/shared/package.json', posix),
        '../shared/package.json',
    );
    assert.equal(
        pathFromRoot(
            'C:\\app',
            'C:\\app\\node_modules\\a\\package.json',
            win32,
        ),
        'node_modules/a/package.json',
    );
    // Another drive or a network share: relative() returns an absolute path.
    assert.equal(
        pathFromRoot('C:\\app', 'D:\\shared\\package.json', win32),
        undefined,
    );
    assert.equal(
        pathFromRoot('C:\\app', '\\\\server\\share\\lib\\package.json', win32),
        undefined,
    );
});
