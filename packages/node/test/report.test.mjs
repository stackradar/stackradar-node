// The Runtime Report body built at start, on fixture apps:
// the Service and Release come from configuration first, then detection.

import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveConfiguration } from '../dist/esm/core/configuration.js';
import { inventoryHash } from '../dist/esm/core/inventory.js';
import { collect } from '../dist/esm/node/start.js';

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const INSTANCE = {
    id: '0192f8c4-7b1e-7c3a-9d2e-4f5a6b7c8d9e',
    started_at: '2026-11-04T10:00:00.000Z',
};
const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-report-')));
after(() => rmSync(base, { recursive: true, force: true }));

function tree(name, files) {
    const root = join(base, name);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }

    return root;
}

const repo = tree('monorepo', {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': SHA,
    'apps/api/package.json': JSON.stringify({ name: '@acme/api' }),
    'apps/api/server.js': '',
});
const entry = join(repo, 'apps/api/server.js');

async function bodyFor(env) {
    const { configuration } = resolveConfiguration(
        {},
        { STACKRADAR_INGEST_KEY: KEY, ...env },
    );
    const { body } = await collect({
        configuration,
        env,
        entry,
        cwd: repo,
        instance: INSTANCE,
    });

    return body;
}

test('the body has every field, with detected Service and Release', async () => {
    const body = await bodyFor({ STACKRADAR_ENVIRONMENT: 'production' });

    assert.deepEqual(
        { ...body, runtime: undefined, platform: undefined },
        {
            protocol_version: 1,
            reporter: { name: '@stackradar/node', version },
            instance: INSTANCE,
            deployment: {
                environment: 'production',
                service: '@acme/api',
                release: { value: SHA, source: 'git' },
                artifact: null,
            },
            runtime: undefined,
            platform: undefined,
            packages: {
                detector: 'dependency-tree',
                status: 'collected',
                ecosystem: 'npm',
                inventory_hash: inventoryHash('npm', []),
            },
        },
    );
    assert.equal(body.runtime.name, 'node');
    assert.equal(body.platform.os, process.platform);
    assert.ok(!JSON.stringify(body).includes(KEY));
});

test('configured values win over detection', async () => {
    const body = await bodyFor({
        STACKRADAR_SERVICE: 'api',
        STACKRADAR_RELEASE: 'v2.4.0',
        STACKRADAR_ARTIFACT: 'sha256:4b7c',
        GITHUB_SHA: 'b'.repeat(40),
    });

    assert.deepEqual(body.deployment, {
        environment: null,
        service: 'api',
        release: { value: 'v2.4.0', source: 'env:STACKRADAR_RELEASE' },
        artifact: 'sha256:4b7c',
    });
});

test('a commit variable wins over .git', async () => {
    const body = await bodyFor({ GITHUB_SHA: 'b'.repeat(40) });

    assert.deepEqual(body.deployment.release, {
        value: 'b'.repeat(40),
        source: 'env:GITHUB_SHA',
    });
});

test('without an app root there is no Service and no .git Release', async () => {
    const { configuration } = resolveConfiguration(
        {},
        { STACKRADAR_INGEST_KEY: KEY },
    );
    const bare = tree('bare', { 'server.js': '' });
    const { appRoot, body } = await collect({
        configuration,
        env: {},
        entry: join(bare, 'server.js'),
        cwd: bare,
        instance: INSTANCE,
    });

    assert.equal(appRoot, null);
    assert.equal(body.deployment.service, null);
    assert.equal(body.deployment.release, null);
});
