// The reporter's per-process state, with its scheduler, output and start
// replaced so no timer or file system is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReporter } from '../dist/esm/core/reporter.js';

const KEY = 'sr_ingest_' + 'a'.repeat(43);

function harness(env = {}, start = async () => {}) {
    const lines = [];
    const scheduled = [];
    const started = [];
    const reporter = createReporter({
        env,
        write: (line) => lines.push(line),
        schedule: (begin) => scheduled.push(begin),
        start: async (configuration, log) => {
            started.push(configuration);
            await start(configuration, log);
        },
    });

    return { reporter, lines, scheduled, started };
}

test('without an Ingest Key nothing is scheduled and nothing is written', () => {
    const { reporter, lines, scheduled } = harness();

    reporter.init();

    assert.deepEqual(lines, []);
    assert.equal(scheduled.length, 0);
});

test('an invalid Ingest Key writes one line, once, and schedules nothing', () => {
    const { reporter, lines, scheduled } = harness({
        STACKRADAR_INGEST_KEY: 'wrong',
    });

    reporter.init();
    reporter.init();

    assert.equal(lines.length, 1);
    assert.match(lines[0], /not valid/);
    assert.equal(scheduled.length, 0);
});

test('several problems in one call share one line', () => {
    const { reporter, lines } = harness({ STACKRADAR_INGEST_KEY: KEY });

    reporter.init({ service: 1, release: 2 });

    assert.deepEqual(lines, [
        'init({ service }) must be a string; ignoring it; init({ release }) must be a string; ignoring it',
    ]);
});

test('later init() calls add options until the reporter starts, which happens once', () => {
    const { reporter, scheduled, started } = harness({
        STACKRADAR_INGEST_KEY: KEY,
    });

    reporter.init();
    reporter.init({ service: 'api' });
    reporter.init({ environment: 'production' });
    assert.equal(scheduled.length, 1);

    scheduled[0]();
    reporter.init({ service: 'ignored' });

    assert.equal(started.length, 1);
    assert.equal(started[0].service, 'api');
    assert.equal(started[0].environment, 'production');
});

test('a call without an options object keeps the options already given', () => {
    const { reporter, scheduled, started } = harness({
        STACKRADAR_INGEST_KEY: KEY,
    });

    reporter.init({ service: 'api' });
    reporter.init(42);
    scheduled[0]();

    assert.equal(started[0].service, 'api');
});

test('a later undefined option never erases an earlier value', () => {
    const { reporter, scheduled, started } = harness();

    reporter.init({ ingestKey: KEY });
    reporter.init({ ingestKey: undefined, service: 'api' });
    scheduled[0]();

    assert.equal(started.length, 1);
    assert.equal(started[0].ingestKey, KEY);
    assert.equal(started[0].service, 'api');
});

test('a later invalid option is dropped and the earlier value kept', () => {
    const { reporter, lines, scheduled, started } = harness();

    reporter.init({ ingestKey: KEY, service: 'api', debug: false });
    reporter.init({ ingestKey: 'wrong', service: 42, debug: 'yes' });
    scheduled[0]();

    assert.equal(started[0].ingestKey, KEY);
    assert.equal(started[0].service, 'api');
    assert.equal(started[0].debug, false);
    assert.equal(lines.length, 1);
    assert.match(
        lines[0],
        /^init\(\{ ingestKey \}\) is not a valid Ingest Key/,
    );
});

test('debug logging reports the configuration without the Ingest Key', () => {
    const { reporter, lines, scheduled } = harness({
        STACKRADAR_INGEST_KEY: KEY,
        STACKRADAR_DEBUG: '1',
    });

    reporter.init({ service: 'api' });
    reporter.init({ release: 'r1' });
    scheduled[0]();
    reporter.init();

    assert.deepEqual(lines, [
        'configured: environment=not set service=api release=not set artifact=not set root=detected',
        'init() was called again before the reporter started; options merged',
        'configured: environment=not set service=api release=r1 artifact=not set root=detected',
        'starting',
        'init() was called after the reporter started; ignoring it',
    ]);
    assert.ok(lines.every((line) => !line.includes(KEY)));
});

test('a failure after start is logged in debug mode and never escapes', async () => {
    const { reporter, lines, scheduled } = harness(
        { STACKRADAR_INGEST_KEY: KEY, STACKRADAR_DEBUG: 'true' },
        async () => {
            throw new Error('disk on fire');
        },
    );

    reporter.init();
    scheduled[0]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lines.at(-1), 'stopped after an error: disk on fire');
});

test('init() never throws, even when writing and scheduling fail', () => {
    const reporter = createReporter({
        env: { STACKRADAR_INGEST_KEY: KEY },
        write: () => {
            throw new Error('stderr closed');
        },
        schedule: () => {
            throw new Error('no timers');
        },
        start: async () => {},
    });

    assert.doesNotThrow(() => reporter.init({ service: 1 }));
});
