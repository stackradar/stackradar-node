// Reporting after start-up with a stand-in for sending: every answer,
// the list upload on 409 and back-off.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReporting } from '../dist/esm/core/lifecycle.js';

const HASH = 'a'.repeat(64);
const BODY = {
    protocol_version: 1,
    packages: {
        detector: 'dependency-tree',
        status: 'collected',
        ecosystem: 'npm',
        inventory_hash: HASH,
    },
};
const PACKAGES = [{ name: 'debug', version: '4.3.7' }];
const MINUTE = 60 * 1000;

/** `answers` are returned in order; an Error is thrown as a network failure. */
function harness(answers, { packages = PACKAGES } = {}) {
    const requests = [];
    const lines = [];
    let clock = 0;
    const reporting = createReporting({
        body: BODY,
        packages,
        send: async (request) => {
            requests.push(request);
            const answer = answers.shift() ?? { status: 204 };
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
        log: (line) => lines.push(line),
        now: () => clock,
    });

    return {
        reporting,
        requests,
        lines,
        advance: (milliseconds) => {
            clock += milliseconds;
        },
    };
}

test('204: the report is accepted and sent again at the next heartbeat', async () => {
    const { reporting, requests } = harness([{ status: 204 }]);

    await reporting.tick();
    await reporting.tick();

    assert.deepEqual(
        requests.map(({ method, path }) => `${method} ${path}`),
        ['POST /v1/runtime-reports', 'POST /v1/runtime-reports'],
    );
    assert.deepEqual(JSON.parse(requests[0].body), BODY);
});

test('409 unknown_inventory: the package list is uploaded under its hash', async () => {
    const { reporting, requests } = harness([
        { status: 409, code: 'unknown_inventory' },
        { status: 204 },
    ]);

    await reporting.tick();

    assert.equal(requests[1].method, 'PUT');
    assert.equal(requests[1].path, `/v1/package-inventories/${HASH}`);
    assert.deepEqual(JSON.parse(requests[1].body), {
        protocol_version: 1,
        ecosystem: 'npm',
        packages: PACKAGES,
    });
});

test('409 without a collected list uploads nothing', async () => {
    const { reporting, requests, lines } = harness(
        [{ status: 409, code: 'unknown_inventory' }],
        { packages: null },
    );

    await reporting.tick();

    assert.equal(requests.length, 1);
    assert.match(lines.at(-1), /none was collected/);
});

test('a list at the 10,000-package limit with long names still fits and is uploaded', async () => {
    // npm names average well under 20 characters; these have 50.
    const full = Array.from({ length: 10_000 }, (_, index) => ({
        name: `@scope-${String(index).padStart(5, '0')}/package-name-${'x'.repeat(24)}`,
        version: '10.20.30',
    }));
    const { reporting, requests } = harness(
        [{ status: 409, code: 'unknown_inventory' }],
        { packages: full },
    );

    await reporting.tick();

    assert.equal(full[0].name.length, 50);
    assert.deepEqual(
        requests.map(({ method }) => method),
        ['POST', 'PUT'],
    );
    assert.ok(Buffer.byteLength(requests[1].body) < 1024 * 1024);
});

test('a list over 1 MB is not uploaded', async () => {
    const big = Array.from({ length: 10_000 }, (_, index) => ({
        name: `package-${index}-${'x'.repeat(100)}`,
        version: '1.0.0',
    }));
    const { reporting, requests, lines } = harness(
        [{ status: 409, code: 'unknown_inventory' }],
        { packages: big },
    );

    await reporting.tick();

    assert.equal(requests.length, 1);
    assert.match(lines.at(-1), /over 1 MB/);
});

test('401, 403 and 410 stop all reporting, for the report and the upload', async () => {
    for (const answers of [
        [{ status: 401 }],
        [{ status: 403 }],
        [{ status: 410, code: 'stop' }],
        [
            { status: 409, code: 'unknown_inventory' },
            { status: 410, code: 'stop' },
        ],
    ]) {
        const { reporting, requests } = harness(answers);

        await reporting.tick();
        const sent = requests.length;
        await reporting.tick();

        assert.equal(reporting.stopped, true);
        assert.equal(requests.length, sent, JSON.stringify(answers));
    }
});

test('413, 422, 5xx and network errors are tried again at the next heartbeat', async () => {
    for (const answer of [
        { status: 413 },
        { status: 422 },
        { status: 500 },
        { status: 503 },
        new Error('connect ECONNREFUSED'),
    ]) {
        const { reporting, requests } = harness([answer]);

        await assert.doesNotReject(reporting.tick());
        await reporting.tick();

        assert.equal(reporting.stopped, false);
        assert.equal(requests.length, 2);
    }
});

test('429 waits for Retry-After, else only until the next heartbeat', async () => {
    const waiting = harness([
        { status: 429, retryAfterMilliseconds: 15 * MINUTE },
    ]);
    await waiting.reporting.tick();
    waiting.advance(10 * MINUTE);
    await waiting.reporting.tick();
    assert.equal(waiting.requests.length, 1);
    waiting.advance(10 * MINUTE);
    await waiting.reporting.tick();
    assert.equal(waiting.requests.length, 2);

    const plain = harness([{ status: 429 }]);
    await plain.reporting.tick();
    plain.advance(10 * MINUTE);
    await plain.reporting.tick();
    assert.equal(plain.requests.length, 2);
});

test('a heartbeat while one is still sending is skipped', async () => {
    let release;
    const requests = [];
    const reporting = createReporting({
        body: BODY,
        packages: PACKAGES,
        send: (request) => {
            requests.push(request);
            return new Promise((resolve) => {
                release = () => resolve({ status: 204 });
            });
        },
        log: () => {},
    });

    const first = reporting.tick();
    await reporting.tick();
    release();
    await first;

    assert.equal(requests.length, 1);
});
