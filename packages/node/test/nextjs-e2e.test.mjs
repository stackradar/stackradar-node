// A real Next.js app set up as the README says, with the packed reporter
// installed from STACKRADAR_PACKAGE (a .tgz): `next build` writes the Build
// Inventory and ships it in standalone output, the standalone server reports
// it, and `vercel build` puts it in every function. Not part of `npm test`:
// it needs the npm registry. CI runs it in the "Next.js" job.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
    cpSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Pinned by version; its own dependencies come from the registry.
const VERCEL = 'vercel@65.4.0';
const INVENTORY = '.stackradar/build-inventory.json';
const KEY = 'sr_ingest_' + 'a'.repeat(43);
const TARBALL = process.env.STACKRADAR_PACKAGE;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-nextjs-')));
const app = join(base, 'app');
const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    VERCEL_TELEMETRY_DISABLED: '1',
};
const run = (command, args) =>
    execFileSync(command, args, { cwd: app, env, stdio: 'inherit' });
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The app's committed lockfile, install scripts off, then the reporter
// under test, saved into the copy's package.json because vercel build
// installs again; each test below starts from this build.
before(
    () => {
        assert.ok(TARBALL, 'set STACKRADAR_PACKAGE to the packed .tgz');
        cpSync(fileURLToPath(new URL('nextjs-app', import.meta.url)), app, {
            recursive: true,
        });
        run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
        run('npm', [
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            TARBALL,
        ]);
        run('npx', ['next', 'build']);
    },
    { timeout: 10 * 60 * 1000 },
);
after(() => rmSync(base, { recursive: true, force: true }));

test('next build ships the Build Inventory, and the standalone server reports it', async () => {
    const inventory = readJson(join(app, INVENTORY));
    assert.deepEqual(
        readJson(join(app, '.next/standalone', INVENTORY)),
        inventory,
    );
    assert.ok(
        inventory.packages.some(
            ({ name, version }) => name === 'debug' && version === '4.3.7',
        ),
    );

    const received = [];
    const ingest = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) {
            body += chunk;
        }
        received.push({ method: request.method, body });
        if (request.method === 'POST') {
            response
                .writeHead(409, { 'content-type': 'application/json' })
                .end('{"code":"unknown_inventory"}');
        } else {
            response.writeHead(204).end();
        }
    });
    ingest.listen(0, '127.0.0.1');
    await once(ingest, 'listening');

    // Math.random() of 0 makes the start delay exactly the 5-second settle.
    const zeroDelay = join(base, 'zero-delay.cjs');
    writeFileSync(zeroDelay, 'Math.random = () => 0;\n');
    const server = spawn(
        process.execPath,
        ['--require', zeroDelay, '.next/standalone/server.js'],
        {
            cwd: app,
            env: {
                PATH: process.env.PATH,
                NEXT_TELEMETRY_DISABLED: '1',
                HOSTNAME: '127.0.0.1',
                PORT: String(await freePort()),
                STACKRADAR_INGEST_KEY: KEY,
                STACKRADAR_INGEST_URL: `http://127.0.0.1:${ingest.address().port}`,
                STACKRADAR_ENVIRONMENT: 'test',
            },
            stdio: 'inherit',
        },
    );
    const exited = once(server, 'exit');

    try {
        const deadline = Date.now() + 30_000;
        while (received.length < 2 && Date.now() < deadline) {
            if (server.exitCode !== null || server.signalCode !== null) {
                assert.fail(
                    `server.js exited (${server.exitCode ?? server.signalCode}) before reporting`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    } finally {
        server.kill();
        await exited;
        ingest.close();
    }

    assert.deepEqual(
        received.map(({ method }) => method),
        ['POST', 'PUT'],
    );
    const report = JSON.parse(received[0].body);
    assert.equal(report.packages.detector, 'build-inventory');
    assert.equal(report.packages.status, 'collected');
    assert.deepEqual(JSON.parse(received[1].body).packages, inventory.packages);
});

test('vercel build puts the Build Inventory in every function', () => {
    // No token: the committed .vercel/project.json stands in for a linked
    // project.
    run('npm', ['exec', '--yes', VERCEL, '--', 'build', '--yes']);

    const functions = join(app, '.vercel/output/functions');
    const configs = readdirSync(functions, { recursive: true })
        .filter((path) => path.endsWith('.func'))
        .map((path) => readJson(join(functions, path, '.vc-config.json')));

    assert.ok(configs.length > 0);
    for (const { filePathMap } of configs) {
        assert.equal(filePathMap?.[INVENTORY], INVENTORY);
    }
});

/** A port nothing listens on; the standalone server needs a number. */
async function freePort() {
    const probe = createTcpServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));

    return port;
}
