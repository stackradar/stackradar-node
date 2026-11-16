// Writing the Build Inventory: the writer, the stackradar-node command and
// withStackRadar() for Next.js.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeBuildInventory } from '../dist/esm/node/build-inventory-writer.js';
import { readBuildInventory } from '../dist/esm/node/build-inventory.js';
import { withStackRadar } from '../dist/esm/next.js';

const FILE = '.stackradar/build-inventory.json';
const CLI = fileURLToPath(new URL('../dist/cjs/cli.js', import.meta.url));
const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-writer-')));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/** A full install on a build machine: production and dev dependencies. */
function project(extra = {}) {
    const root = join(base, `project-${(count += 1)}`);
    const files = {
        'package.json': {
            name: 'web',
            dependencies: {
                debug: '4.3.7',
                'my-colors': 'npm:picocolors@1.1.1',
            },
            devDependencies: { typescript: '5.6.3' },
        },
        'node_modules/debug/package.json': {
            name: 'debug',
            version: '4.3.7',
            dependencies: { ms: '^2.1.3' },
        },
        'node_modules/ms/package.json': { name: 'ms', version: '2.1.3' },
        'node_modules/my-colors/package.json': {
            name: 'picocolors',
            version: '1.1.1',
        },
        'node_modules/typescript/package.json': {
            name: 'typescript',
            version: '5.6.3',
        },
        ...extra,
    };
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(
            join(root, path),
            typeof content === 'string' ? content : JSON.stringify(content),
        );
    }

    return root;
}

const EXPECTED = {
    format: 1,
    ecosystem: 'npm',
    generator: { name: '@stackradar/node', version },
    packages: [
        { name: 'debug', version: '4.3.7' },
        { name: 'ms', version: '2.1.3' },
        { name: 'picocolors', version: '1.1.1' },
    ],
};

test('the file holds the production tree, sorted, without timestamps or paths', async () => {
    const root = project();

    const result = await writeBuildInventory({ appRoot: root, pnp: null });
    const first = readFileSync(join(root, FILE), 'utf8');
    await writeBuildInventory({ appRoot: root, pnp: null });

    assert.deepEqual(result, {
        written: true,
        path: join(root, FILE),
        packages: 3,
    });
    assert.deepEqual(JSON.parse(first), EXPECTED);
    assert.equal(readFileSync(join(root, FILE), 'utf8'), first);
    assert.deepEqual(readdirSync(join(root, '.stackradar')), [
        'build-inventory.json',
    ]);
    // The reporter's own reader accepts what the writer wrote.
    assert.deepEqual(await readBuildInventory(root), {
        status: 'read',
        packages: EXPECTED.packages,
    });
});

test('an incomplete install writes nothing and removes an earlier file', async () => {
    const root = project();
    await writeBuildInventory({ appRoot: root, pnp: null });
    rmSync(join(root, 'node_modules/ms'), { recursive: true });

    const result = await writeBuildInventory({ appRoot: root, pnp: null });

    assert.equal(result.written, false);
    assert.match(result.warning, /not installed/);
    assert.equal(existsSync(join(root, FILE)), false);
});

test('a regeneration that fails removes the earlier file, so it never ships stale', async () => {
    const root = project();
    await writeBuildInventory({ appRoot: root, pnp: null });
    // The temporary file cannot be written: a directory is in its place.
    mkdirSync(join(root, `${FILE}.${process.pid}.tmp`));

    const result = await writeBuildInventory({ appRoot: root, pnp: null });

    assert.equal(result.written, false);
    assert.match(result.warning, /^could not write the Build Inventory \(/);
    assert.equal(existsSync(join(root, FILE)), false);
    assert.notEqual((await readBuildInventory(root)).status, 'read');
});

test(
    'a failed regeneration that cannot remove the earlier file says so',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    async () => {
        const root = project();
        await writeBuildInventory({ appRoot: root, pnp: null });
        chmodSync(join(root, '.stackradar'), 0o555);

        try {
            const result = await writeBuildInventory({
                appRoot: root,
                pnp: null,
            });

            assert.equal(result.written, false);
            assert.match(
                result.warning,
                /nor remove the earlier .*build-inventory\.json: delete it, or the build ships a stale package list$/,
            );
        } finally {
            chmodSync(join(root, '.stackradar'), 0o755);
        }
    },
);

test('directories served to browsers are refused', async () => {
    const root = project();

    for (const out of ['public', 'public/assets', '.next/static']) {
        const result = await writeBuildInventory({
            appRoot: root,
            outDir: join(root, out),
            pnp: null,
        });

        assert.equal(result.written, false, out);
        assert.match(result.warning, /served to browsers/);
        assert.equal(existsSync(join(root, out, FILE)), false);
    }
});

test('an output directory without a package.json gets the file and a warning', async () => {
    const root = project();

    const result = await writeBuildInventory({
        appRoot: root,
        outDir: join(root, 'dist'),
        pnp: null,
    });

    assert.equal(result.written, true);
    assert.match(result.warning, /has no package\.json/);
    assert.deepEqual(
        JSON.parse(readFileSync(join(root, 'dist', FILE), 'utf8')),
        EXPECTED,
    );
});

test('the command writes into --out and never fails the build', () => {
    const root = project({
        '.output/server/package.json': { name: 'web-output', dependencies: {} },
    });
    const run = (...args) =>
        spawnSync(process.execPath, [CLI, 'build-inventory', ...args], {
            cwd: root,
            encoding: 'utf8',
        });

    const written = run('--out', '.output/server');
    assert.equal(written.status, 0);
    assert.equal(
        written.stdout,
        `Build Inventory: 3 packages in ${join('.output/server', FILE)}\n`,
    );
    assert.deepEqual(
        JSON.parse(readFileSync(join(root, '.output/server', FILE), 'utf8')),
        EXPECTED,
    );

    const refused = run('--out=public');
    assert.equal(refused.status, 0);
    assert.match(
        refused.stderr,
        /^@stackradar\/node: public is served to browsers/,
    );

    const mistyped = run('--output', 'dist');
    assert.equal(mistyped.status, 1);
    assert.match(mistyped.stderr, /^Usage: stackradar-node <command>/);
});

test('a closed stdout does not fail the command after the file is written', async () => {
    const root = project();
    const child = spawn(process.execPath, [CLI, 'build-inventory'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Like `stackradar-node build-inventory | head -0`.
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    const [code] = await once(child, 'exit');

    assert.equal(stderr, '');
    assert.equal(code, 0);
    assert.deepEqual(
        JSON.parse(readFileSync(join(root, FILE), 'utf8')),
        EXPECTED,
    );
});

test('withStackRadar writes during next build and ships the file with every route', async () => {
    const root = project();
    const nextConfig = {
        output: 'standalone',
        outputFileTracingIncludes: {
            '/api/*': ['./data/**'],
            '/*': ['./fonts/**'],
        },
    };

    const config = await withStackRadar(nextConfig, { dir: root })(
        'phase-production-build',
        {},
    );

    assert.deepEqual(config, {
        output: 'standalone',
        outputFileTracingIncludes: {
            '/api/*': ['./data/**'],
            '/*': ['./fonts/**', './.stackradar/build-inventory.json'],
        },
    });
    assert.deepEqual(
        JSON.parse(readFileSync(join(root, FILE), 'utf8')),
        EXPECTED,
    );
});

test('withStackRadar composes with config functions and leaves other phases alone', async () => {
    const root = project();
    const phases = [];
    const wrapped = withStackRadar(
        async (phase) => {
            phases.push(phase);
            return { reactStrictMode: true };
        },
        { dir: root },
    );

    assert.deepEqual(await wrapped('phase-development-server', {}), {
        reactStrictMode: true,
    });
    assert.equal(existsSync(join(root, FILE)), false);
    assert.deepEqual(await wrapped('phase-production-build', {}), {
        reactStrictMode: true,
        outputFileTracingIncludes: {
            '/*': ['./.stackradar/build-inventory.json'],
        },
    });
    assert.deepEqual(phases, [
        'phase-development-server',
        'phase-production-build',
    ]);
});

test('withStackRadar never fails the build: missing dir or a broken install only warn', async () => {
    const nextConfig = { output: 'standalone' };
    const missingDir = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import { withStackRadar } from './dist/esm/next.js';
             const config = await withStackRadar({ output: 'standalone' })('phase-production-build', {});
             console.log(JSON.stringify(config));`,
        ],
        {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            encoding: 'utf8',
        },
    );

    assert.equal(missingDir.status, 0);
    assert.equal(missingDir.stdout, '{"output":"standalone"}\n');
    assert.match(missingDir.stderr, /needs the project directory/);

    const broken = project({ 'package.json': '{ not json' });
    assert.deepEqual(
        await withStackRadar(nextConfig, { dir: broken })(
            'phase-production-build',
            {},
        ),
        nextConfig,
    );
});
