// App root fixtures, built in a temporary directory: direct
// launches from several working directories, Next.js standalone in a
// monorepo, a launcher inside node_modules, and no package.json at all.

import assert from 'node:assert/strict';
import {
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

import { resolveAppRoot } from '../dist/esm/node/app-root.js';

// The real path, because macOS reports /var for /private/var.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-app-root-')));
after(() => rmSync(base, { recursive: true, force: true }));

function tree(name, files) {
    const root = join(base, name);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(
            join(root, path),
            typeof content === 'string' ? content : JSON.stringify(content),
        );
    }

    return root;
}

const resolveFrom = (cwd, entry, configured = null) =>
    resolveAppRoot({ configured, entry, cwd });

test('a direct launch finds the app from any working directory', async () => {
    const repo = tree('direct', {
        'package.json': {
            name: 'monorepo',
            private: true,
            workspaces: ['apps/*'],
        },
        'apps/api/package.json': {
            name: 'api',
            dependencies: { express: '^4' },
        },
        'apps/api/dist/package.json': { type: 'module' },
        'apps/api/dist/server.js': '',
    });
    const api = join(repo, 'apps/api');

    for (const [cwd, entry] of [
        [api, 'dist/server.js'],
        [repo, 'apps/api/dist/server.js'],
        ['/', join(api, 'dist/server.js')],
    ]) {
        assert.deepEqual(
            await resolveFrom(cwd, entry),
            { path: api, source: 'entry' },
            cwd,
        );
    }
});

test('Next.js standalone in a monorepo finds the app inside the build output', async () => {
    const repo = tree('standalone', {
        'package.json': { name: 'monorepo', private: true },
        'apps/web/package.json': {
            name: 'web',
            dependencies: { next: '16.0.0' },
        },
        'apps/web/.next/standalone/package.json': {
            name: 'monorepo',
            private: true,
        },
        'apps/web/.next/standalone/apps/web/package.json': {
            name: 'web',
            dependencies: { next: '16.0.0' },
        },
        'apps/web/.next/standalone/apps/web/server.js': '',
    });
    const output = join(repo, 'apps/web/.next/standalone/apps/web');

    for (const cwd of [output, join(repo, 'apps/web'), '/']) {
        assert.deepEqual(
            await resolveFrom(cwd, join(output, 'server.js')),
            { path: output, source: 'entry' },
            cwd,
        );
    }
});

test('a launcher inside node_modules uses the working directory', async () => {
    const app = tree('launcher', {
        'package.json': { name: 'web', dependencies: { next: '16.0.0' } },
        'node_modules/next/package.json': { name: 'next', version: '16.0.0' },
        'node_modules/next/dist/bin/next': '',
        'src/page.js': '',
    });

    assert.deepEqual(
        await resolveFrom(app, join(app, 'node_modules/next/dist/bin/next')),
        {
            path: app,
            source: 'working-directory',
        },
    );
    assert.deepEqual(
        await resolveFrom(
            join(app, 'src'),
            join(app, 'node_modules/next/dist/bin/next'),
        ),
        { path: app, source: 'working-directory' },
    );
});

test('a symlinked entry script is followed to its real location', async () => {
    const repo = tree('symlink', {
        'app/package.json': { name: 'app' },
        'app/index.js': '',
    });
    mkdirSync(join(repo, 'bin'));
    symlinkSync(join(repo, 'app/index.js'), join(repo, 'bin/start.js'));

    assert.deepEqual(await resolveFrom(repo, 'bin/start.js'), {
        path: join(repo, 'app'),
        source: 'entry',
    });
});

test('without an entry script the working directory is used', async () => {
    const app = tree('eval', { 'package.json': { name: 'app' } });

    assert.deepEqual(await resolveFrom(app, undefined), {
        path: app,
        source: 'working-directory',
    });
});

test('a configured root wins and is resolved against the working directory', async () => {
    const repo = tree('configured', {
        'apps/api/package.json': { name: 'api' },
    });

    assert.deepEqual(await resolveFrom(repo, join(repo, 'x.js'), 'apps/api'), {
        path: join(repo, 'apps/api'),
        source: 'configured',
    });
});

test('without a package.json that names an app, there is no app root', async () => {
    const bare = tree('bare', {
        'dist/package.json': { type: 'module' },
        'dist/server.js': '',
        'broken/package.json': '{ not json',
        'broken/index.js': '',
    });

    assert.equal(await resolveFrom(bare, join(bare, 'dist/server.js')), null);
    assert.equal(await resolveFrom(bare, join(bare, 'broken/index.js')), null);
    assert.equal(await resolveFrom(bare, join(bare, 'missing.js')), null);
});
