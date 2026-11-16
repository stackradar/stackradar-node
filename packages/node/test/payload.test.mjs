// The payload audit: every request the reporter sends, in each package
// status, captured by a fake ingest server and checked against the closed
// JSON Schemas in test/schema/. Needs the repository's dev dependencies (ajv), so it runs in the
// Checks job rather than on every supported Node.js version.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { createReporting } from '../dist/esm/core/lifecycle.js';
import { buildReportBody } from '../dist/esm/core/report.js';
import { writeBuildInventory } from '../dist/esm/node/build-inventory-writer.js';
import { collectPackages } from '../dist/esm/node/packages.js';
import { runtimeFacts } from '../dist/esm/node/runtime.js';
import { collect, userAgent } from '../dist/esm/node/start.js';
import { createSend } from '../dist/esm/node/transport.js';

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const schema = (name) =>
    JSON.parse(
        readFileSync(new URL(`schema/${name}`, import.meta.url), 'utf8'),
    );

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validReport = ajv.compile(schema('runtime-report.schema.json'));
const validList = ajv.compile(schema('package-list.schema.json'));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-payload-')));
const received = [];
const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
    }
    received.push({ method: request.method, headers: request.headers, body });
    // Every report asks for its list, so every list is uploaded.
    if (request.method === 'POST') {
        response
            .writeHead(409, { 'content-type': 'application/json' })
            .end('{"code":"unknown_inventory"}');
    } else {
        response.writeHead(204).end();
    }
});
before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
});
after(() => {
    server.close();
    rmSync(base, { recursive: true, force: true });
});

function copyFixture(name, target) {
    const root = join(base, target);
    cpSync(join(FIXTURES, name, 'layout'), root, {
        recursive: true,
        verbatimSymlinks: true,
    });

    return root;
}

const configuration = (fields = {}) => ({
    ingestKey: KEY,
    environment: null,
    service: null,
    release: null,
    artifact: null,
    root: null,
    debug: false,
    ingestUrl: `http://127.0.0.1:${server.address().port}`,
    ...fields,
});
const instance = () => ({
    id: randomUUID(),
    started_at: new Date().toISOString(),
});

/** One report through the real collection, body, lifecycle and transport. */
async function report({ body, packages }) {
    const before = received.length;
    await createReporting({
        body,
        packages,
        send: createSend({
            ingestUrl: configuration().ingestUrl,
            ingestKey: KEY,
            userAgent: userAgent(body),
        }),
        log: () => {},
    }).tick();

    return received.slice(before);
}

async function collected(root, fields = {}, env = {}) {
    return collect({
        configuration: configuration({ root, ...fields }),
        env,
        entry: undefined,
        cwd: root,
        instance: instance(),
    });
}

test('every request in every package status matches the closed schemas', async () => {
    const npm = copyFixture('npm', 'npm');
    const withInventory = copyFixture('npm', 'build-inventory');
    await writeBuildInventory({ appRoot: withInventory, pnp: null });
    const standalone = copyFixture('nextjs-standalone', 'standalone');
    mkdirSync(join(standalone, '.git'));
    writeFileSync(join(standalone, '.git/HEAD'), `${SHA}\n`);
    const empty = join(base, 'empty');
    mkdirSync(empty);

    const failed = await collectPackages(
        npm,
        {},
        {
            limits: { maxPackages: 1, milliseconds: 5_000, concurrency: 8 },
        },
    );
    const scenarios = {
        // dependency-tree, collected; Release from a CI variable.
        collected: await collected(
            npm,
            { environment: 'production', artifact: `sha256:${'b'.repeat(64)}` },
            { GITHUB_SHA: SHA },
        ),
        // build-inventory, collected; configured Service and Release.
        'build-inventory': await collected(withInventory, {
            service: 'api',
            release: { value: 'api@2.4.0', source: 'init' },
        }),
        // A bundled app: partial with errors; Release from .git.
        partial: await collect({
            configuration: configuration({ root: standalone }),
            env: { __NEXT_PRIVATE_STANDALONE_CONFIG: '{}' },
            entry: undefined,
            cwd: standalone,
            instance: instance(),
        }),
        // No package.json: nothing to report and no list.
        not_found: await collected(empty),
        // Above the package limit: no list.
        failed: {
            body: buildReportBody({
                configuration: configuration(),
                instance: instance(),
                service: 'app',
                release: null,
                facts: runtimeFacts(),
                packages: failed.section,
            }),
            packages: failed.packages,
        },
    };

    const requests = {};
    for (const [name, scenario] of Object.entries(scenarios)) {
        requests[name] = await report(scenario);
    }

    assert.deepEqual(
        Object.fromEntries(
            Object.entries(requests).map(([name, sent]) => [
                name,
                [
                    JSON.parse(sent[0].body).packages.status,
                    ...sent.map(({ method }) => method),
                ],
            ]),
        ),
        {
            collected: ['collected', 'POST', 'PUT'],
            'build-inventory': ['collected', 'POST', 'PUT'],
            partial: ['partial', 'POST', 'PUT'],
            not_found: ['not_found', 'POST'],
            failed: ['failed', 'POST'],
        },
    );
    for (const [name, sent] of Object.entries(requests)) {
        for (const { method, headers, body } of sent) {
            const valid = method === 'POST' ? validReport : validList;
            assert.ok(
                valid(JSON.parse(body)),
                `${name} ${method}: ${ajv.errorsText(valid.errors)}`,
            );
            // Node.js adds host and connection; the reporter sets the rest.
            assert.deepEqual(Object.keys(headers).sort(), [
                'authorization',
                'connection',
                'content-length',
                'content-type',
                'host',
                'user-agent',
            ]);
            assert.equal(headers.authorization, `Bearer ${KEY}`);
            assert.equal(headers['content-type'], 'application/json');
            assert.equal(
                headers['user-agent'],
                userAgent(JSON.parse(sent[0].body)),
            );
        }
    }
    const { deployment } = JSON.parse(requests.partial[0].body);
    assert.deepEqual(deployment.release, { value: SHA, source: 'git' });
});

test('the schemas are closed: a field they do not list fails', () => {
    const body = buildReportBody({
        configuration: configuration(),
        instance: instance(),
        service: 'app',
        release: null,
        facts: runtimeFacts(),
        packages: {
            detector: 'none',
            status: 'not_found',
            ecosystem: null,
            inventory_hash: null,
        },
    });

    assert.ok(validReport(body), ajv.errorsText(validReport.errors));
    assert.equal(validReport({ ...body, hostname: 'web-1' }), false);
    assert.equal(
        validReport({ ...body, platform: { ...body.platform, cpus: 8 } }),
        false,
    );
    assert.equal(
        validList({
            protocol_version: 1,
            ecosystem: 'npm',
            packages: [{ name: 'a', version: '1.0.0', path: '/srv/app' }],
        }),
        false,
    );
});
