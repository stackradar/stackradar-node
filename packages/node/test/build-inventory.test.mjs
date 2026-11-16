// The build-inventory detector: read first, complete even for bundled
// apps, and an unusable file falls through to the next detector.

import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { inventoryHash } from '../dist/esm/core/inventory.js';
import { collectPackages } from '../dist/esm/node/packages.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-inventory-')));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

function app(inventory) {
    const root = join(base, `app-${(count += 1)}`);
    const files = {
        'package.json': JSON.stringify({
            name: 'web',
            dependencies: { next: '16.4.5', debug: '4.3.7' },
        }),
        // A standalone build keeps only part of its packages.
        'node_modules/next/package.json': JSON.stringify({
            name: 'next',
            version: '16.4.5',
        }),
    };
    if (inventory !== undefined) {
        files['.stackradar/build-inventory.json'] =
            typeof inventory === 'string'
                ? inventory
                : JSON.stringify(inventory);
    }
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }

    return root;
}

const PACKAGES = [
    { name: 'next', version: '16.4.5' },
    { name: 'debug', version: '4.3.7' },
    { name: 'ms', version: '2.1.3' },
];
const inventory = (fields = {}) => ({
    format: 1,
    ecosystem: 'npm',
    generator: { name: '@stackradar/node', version: '0.1.0' },
    packages: PACKAGES,
    ...fields,
});
const STANDALONE = { __NEXT_PRIVATE_STANDALONE_CONFIG: '{}' };

test('a Build Inventory gives the complete list, even in a standalone build', async () => {
    const { section, packages } = await collectPackages(
        app(inventory()),
        STANDALONE,
    );

    assert.deepEqual(section, {
        detector: 'build-inventory',
        status: 'collected',
        ecosystem: 'npm',
        inventory_hash: inventoryHash('npm', PACKAGES),
    });
    assert.deepEqual(
        packages.map(({ name }) => name),
        ['debug', 'ms', 'next'],
    );
});

test('an empty Build Inventory is a complete, empty list', async () => {
    const { section } = await collectPackages(
        app(inventory({ packages: [] })),
        {},
    );

    assert.equal(section.status, 'collected');
    assert.equal(section.inventory_hash, inventoryHash('npm', []));
});

test('without a Build Inventory a standalone build reports what it can see', async () => {
    const { section, packages } = await collectPackages(app(), STANDALONE);

    assert.equal(section.detector, 'dependency-tree');
    assert.equal(section.status, 'partial');
    assert.deepEqual(section.errors, [{ code: 'bundled_app' }]);
    assert.deepEqual(packages, [{ name: 'next', version: '16.4.5' }]);
});

test('an unusable Build Inventory is reported and the walk runs instead', async () => {
    for (const unusable of [
        '{ not json',
        inventory({ format: 2 }),
        inventory({ ecosystem: 'pypi' }),
        inventory({ packages: 'debug' }),
        inventory({ packages: [...PACKAGES, { name: 'bad', version: 1 }] }),
        inventory({ packages: [{ name: 'a\u0000b', version: '1.0.0' }] }),
        // C1 controls too: the server refuses every control character.
        inventory({ packages: [{ name: 'ms', version: '2.1.3\u0085' }] }),
        inventory({ padding: 'x'.repeat(1024 * 1024) }),
    ]) {
        const { section } = await collectPackages(app(unusable), STANDALONE);

        assert.equal(section.detector, 'dependency-tree');
        assert.equal(section.status, 'partial');
        assert.deepEqual(section.errors, [
            { code: 'bundled_app' },
            {
                code: 'invalid_build_inventory',
                path: '.stackradar/build-inventory.json',
            },
        ]);
    }
});

test('a failed walk after an unusable Build Inventory still sends at most 50 errors', async () => {
    const root = app('{ not json');
    // 60 installed packages whose package.json cannot be read, and a limit
    // of one package, so the walk records 50 errors and then fails.
    const dependencies = { next: '16.4.5' };
    for (let index = 0; index < 60; index += 1) {
        dependencies[`broken-${index}`] = '1.0.0';
        mkdirSync(join(root, 'node_modules', `broken-${index}`), {
            recursive: true,
        });
        writeFileSync(
            join(root, 'node_modules', `broken-${index}`, 'package.json'),
            '{ not json',
        );
    }
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'web', dependencies }),
    );

    const { section } = await collectPackages(root, STANDALONE, {
        limits: { maxPackages: 0, milliseconds: 60_000, concurrency: 100 },
    });

    assert.equal(section.status, 'failed');
    assert.equal(section.errors.length, 50);
    assert.deepEqual(section.errors[0], {
        code: 'invalid_build_inventory',
        path: '.stackradar/build-inventory.json',
    });
});
