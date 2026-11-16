// The transport against a local fake ingest server and proxy, and a plain
// Node.js app reporting end to end.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, globalAgent } from 'node:http';
import { createServer as createTcpServer, Socket } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createSend,
    retryAfterMilliseconds,
} from '../dist/esm/node/transport.js';
import { inventoryHash } from '../dist/esm/core/inventory.js';
import { createReporting } from '../dist/esm/core/lifecycle.js';

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/** A fake ingest server; `respond(request, body)` returns [status, headers, body]. */
async function ingestServer(respond = () => [204, {}, '']) {
    const received = [];
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) {
            body += chunk;
        }
        received.push({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body,
        });
        const [status, headers, text] = respond(request, body);
        response.writeHead(status, headers).end(text);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        received,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test('a request carries the key, JSON and the user agent, and reads the answer', async () => {
    const server = await ingestServer(() => [
        409,
        { 'content-type': 'application/json', 'retry-after': '30' },
        JSON.stringify({ message: 'Upload it.', code: 'unknown_inventory' }),
    ]);
    const send = createSend({
        ingestUrl: server.url,
        ingestKey: KEY,
        userAgent: '@stackradar/node/0.0.0 (node 24.0.0)',
    });

    const response = await send({
        method: 'POST',
        path: '/v1/runtime-reports',
        body: '{"protocol_version":1}',
    });
    await server.close();

    assert.deepEqual(response, {
        status: 409,
        code: 'unknown_inventory',
        retryAfterMilliseconds: 30_000,
    });
    const [request] = server.received;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/runtime-reports');
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(
        request.headers['user-agent'],
        '@stackradar/node/0.0.0 (node 24.0.0)',
    );
    assert.equal(request.body, '{"protocol_version":1}');
});

test('debug mode prints every request as sent, with the Ingest Key hidden, and still sends it', async () => {
    const server = await ingestServer();
    const lines = [];
    const send = createSend({
        ingestUrl: server.url,
        ingestKey: KEY,
        userAgent: 'test',
        log: (line) => lines.push(line),
    });

    await send({
        method: 'PUT',
        path: `/v1/package-inventories/${'a'.repeat(64)}`,
        body: '{"protocol_version":1,"ecosystem":"npm","packages":[]}',
    });
    await server.close();

    assert.deepEqual(lines, [
        `request: PUT ${server.url}/v1/package-inventories/${'a'.repeat(64)}`,
        'headers: {"authorization":"Bearer [hidden]","content-type":"application/json","content-length":54,"user-agent":"test"}',
        'body: {"protocol_version":1,"ecosystem":"npm","packages":[]}',
    ]);
    assert.equal(server.received.length, 1);
    assert.equal(server.received[0].body, lines[2].slice('body: '.length));
    assert.ok(lines.every((line) => !line.includes(KEY)));
});

test('Retry-After is read in seconds or as a date, and capped', () => {
    const now = () => Date.parse('2026-11-04T10:00:00Z');

    assert.equal(retryAfterMilliseconds('120', now), 120_000);
    assert.equal(
        retryAfterMilliseconds('Wed, 04 Nov 2026 10:01:00 GMT', now),
        60_000,
    );
    assert.equal(
        retryAfterMilliseconds('Wed, 04 Nov 2026 09:00:00 GMT', now),
        0,
    );
    assert.equal(retryAfterMilliseconds('9999999', now), 24 * 60 * 60 * 1000);
    assert.equal(retryAfterMilliseconds('soon', now), undefined);
    assert.equal(retryAfterMilliseconds(undefined, now), undefined);
});

test('a refused connection and a server that never answers both reject', async () => {
    const closed = createTcpServer().listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    const silent = createTcpServer(() => {}).listen(0, '127.0.0.1');
    await once(silent, 'listening');

    const request = { method: 'POST', path: '/v1/runtime-reports', body: '{}' };
    await assert.rejects(
        createSend({
            ingestUrl: `http://127.0.0.1:${port}`,
            ingestKey: KEY,
            userAgent: 'test',
        })(request),
    );
    await assert.rejects(
        createSend({
            ingestUrl: `http://127.0.0.1:${silent.address().port}`,
            ingestKey: KEY,
            userAgent: 'test',
            timeoutMilliseconds: 200,
        })(request),
        /timed out/,
    );
    silent.close();
});

test(
    'the deadline covers connecting: a connection that never opens rejects',
    { timeout: 5_000 },
    async () => {
        // A socket that never connects, as behind a firewall that drops packets.
        const createConnection = globalAgent.createConnection;
        globalAgent.createConnection = () => {
            const socket = new Socket();
            socket.connecting = true;
            return socket;
        };
        // The request never keeps a process alive, so the test does.
        const alive = setInterval(() => {}, 1000);
        const startedAt = Date.now();

        try {
            await assert.rejects(
                createSend({
                    ingestUrl: 'http://127.0.0.1:9',
                    ingestKey: KEY,
                    userAgent: 'test',
                    timeoutMilliseconds: 200,
                })({ method: 'POST', path: '/v1/runtime-reports', body: '{}' }),
                /timed out/,
            );
        } finally {
            clearInterval(alive);
            globalAgent.createConnection = createConnection;
        }
        assert.ok(Date.now() - startedAt < 2_000);
    },
);

test(
    'the deadline covers the whole answer: a trickling response rejects and the next tick sends again',
    { timeout: 5_000 },
    async (t) => {
        let requests = 0;
        const responses = new Set();
        const server = createServer((request, response) => {
            requests += 1;
            request.resume();
            response.writeHead(200, { 'content-type': 'application/json' });
            responses.add(response);
            // One byte every 20 ms: never idle long enough for a socket timeout.
            const trickle = setInterval(() => response.write(' '), 20);
            response.on('close', () => {
                clearInterval(trickle);
                responses.delete(response);
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => {
            for (const response of responses) {
                response.destroy();
            }
            server.close();
        });

        const logged = [];
        const reporting = createReporting({
            body: { packages: { inventory_hash: null, ecosystem: null } },
            packages: null,
            send: createSend({
                ingestUrl: `http://127.0.0.1:${server.address().port}`,
                ingestKey: KEY,
                userAgent: 'test',
                timeoutMilliseconds: 300,
            }),
            log: (line) => logged.push(line),
        });

        const startedAt = Date.now();
        await reporting.tick();
        const firstTick = Date.now() - startedAt;
        await reporting.tick();

        assert.ok(firstTick < 1_500, `${firstTick} ms`);
        assert.equal(requests, 2);
        assert.deepEqual(logged, [
            'sending failed (the request timed out); trying again at the next heartbeat',
            'sending failed (the request timed out); trying again at the next heartbeat',
        ]);
    },
);

test('a request in flight does not keep the process alive', async () => {
    const silent = createTcpServer(() => {}).listen(0, '127.0.0.1');
    await once(silent, 'listening');

    const child = spawn(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import { createSend } from './dist/esm/node/transport.js';
             createSend({ ingestUrl: 'http://127.0.0.1:${silent.address().port}', ingestKey: 'k', userAgent: 'test' })
                 ({ method: 'POST', path: '/', body: '{}' }).catch(() => {});`,
        ],
        { cwd: packageDirectory },
    );
    const startedAt = Date.now();
    const [code] = await once(child, 'exit');
    silent.close();

    assert.equal(code, 0);
    assert.ok(Date.now() - startedAt < 4_000);
});

test(
    'a proxy from NODE_USE_ENV_PROXY carries the request',
    {
        skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
    },
    async () => {
        // A plain-HTTP target reaches the proxy as an absolute-form request.
        const proxy = await ingestServer(() => [204, {}, '']);
        const child = spawn(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                // The request never keeps a process alive, so this app does.
                `import { createSend } from './dist/esm/node/transport.js';
             const alive = setInterval(() => {}, 1000);
             const { status } = await createSend({ ingestUrl: 'http://ingest.example.test', ingestKey: 'k', userAgent: 'test' })
                 ({ method: 'POST', path: '/v1/runtime-reports', body: '{}' });
             console.log(status);
             clearInterval(alive);`,
            ],
            {
                cwd: packageDirectory,
                env: {
                    PATH: process.env.PATH,
                    NODE_USE_ENV_PROXY: '1',
                    HTTP_PROXY: proxy.url,
                },
            },
        );
        let stdout = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        await once(child, 'exit');
        await proxy.close();

        assert.equal(stdout.trim(), '204');
        assert.equal(
            proxy.received[0]?.url,
            'http://ingest.example.test/v1/runtime-reports',
        );
    },
);

test('a plain Node.js app reports end to end: report, 409, list upload, printed in debug mode', async () => {
    const server = await ingestServer((request) =>
        request.method === 'POST'
            ? [
                  409,
                  { 'content-type': 'application/json' },
                  '{"code":"unknown_inventory"}',
              ]
            : [204, {}, ''],
    );
    // Math.random() of 0 makes the start delay exactly the 5-second settle.
    const child = spawn(
        process.execPath,
        [
            '-e',
            `Math.random = () => 0;
             require('@stackradar/node').init({ service: 'api' });
             setInterval(() => {}, 1000);`,
        ],
        {
            cwd: packageDirectory,
            env: {
                PATH: process.env.PATH,
                STACKRADAR_INGEST_KEY: KEY,
                STACKRADAR_INGEST_URL: server.url,
                STACKRADAR_ENVIRONMENT: 'test',
                STACKRADAR_DEBUG: '1',
            },
        },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    const deadline = Date.now() + 15_000;
    while (server.received.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
    await server.close();

    const [report, upload] = server.received;
    const body = JSON.parse(report.body);
    const list = JSON.parse(upload.body);
    assert.equal(report.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(body.deployment, {
        environment: 'test',
        service: 'api',
        release: body.deployment.release,
        artifact: null,
    });
    assert.equal(body.packages.status, 'collected');
    assert.equal(upload.method, 'PUT');
    assert.equal(
        upload.url,
        `/v1/package-inventories/${body.packages.inventory_hash}`,
    );
    assert.equal(
        inventoryHash('npm', list.packages),
        body.packages.inventory_hash,
    );
    // Debug mode printed both requests exactly as the server received them.
    assert.ok(stderr.includes(`body: ${report.body}\n`));
    assert.ok(stderr.includes(`body: ${upload.body}\n`));
    assert.match(
        stderr,
        /request: PUT http:\/\/127\.0\.0\.1:\d+\/v1\/package-inventories\//,
    );
    assert.ok(stderr.includes('"authorization":"Bearer [hidden]"'));
    assert.ok(!stderr.includes(KEY));
});
