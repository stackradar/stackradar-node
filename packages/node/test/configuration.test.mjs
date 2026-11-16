// Configuration: init() options, checked by validateOptions,
// then environment variables, then detection.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    resolveConfiguration,
    validateOptions,
} from '../dist/esm/core/configuration.js';

/** One init() call, as the reporter makes it. */
function resolve(options, env) {
    const validation = validateOptions(options);
    const resolution = resolveConfiguration(validation.options, env);

    return {
        ...resolution,
        warnings: [...validation.warnings, ...resolution.warnings],
    };
}

const KEY = 'sr_ingest_' + 'a'.repeat(43);
const OTHER_KEY = 'sr_ingest_' + 'b'.repeat(43);

test('without an Ingest Key there is no configuration and no warning', () => {
    assert.deepEqual(resolve(undefined, {}), {
        configuration: null,
        debug: false,
        warnings: [],
    });
});

test('an empty environment variable counts as unset', () => {
    const { configuration, warnings } = resolve(undefined, {
        STACKRADAR_INGEST_KEY: '  ',
    });

    assert.equal(configuration, null);
    assert.deepEqual(warnings, []);
});

test('environment variables configure the reporter, trimmed', () => {
    const { configuration } = resolve(undefined, {
        STACKRADAR_INGEST_KEY: ` ${KEY}\n`,
        STACKRADAR_ENVIRONMENT: ' production ',
        STACKRADAR_SERVICE: 'api',
        STACKRADAR_RELEASE: '9f8e7d6',
        STACKRADAR_ARTIFACT: 'sha256:4b7c',
        STACKRADAR_ROOT: 'apps/api',
    });

    assert.deepEqual(configuration, {
        ingestKey: KEY,
        environment: 'production',
        service: 'api',
        release: { value: '9f8e7d6', source: 'env:STACKRADAR_RELEASE' },
        artifact: 'sha256:4b7c',
        root: 'apps/api',
        debug: false,
        ingestUrl: 'https://ingest.stackradar.com',
    });
});

test('init() options win over environment variables', () => {
    const { configuration } = resolve(
        { ingestKey: OTHER_KEY, service: 'worker', debug: true },
        {
            STACKRADAR_INGEST_KEY: KEY,
            STACKRADAR_SERVICE: 'api',
            STACKRADAR_DEBUG: '0',
        },
    );

    assert.equal(configuration?.ingestKey, OTHER_KEY);
    assert.equal(configuration?.service, 'worker');
    assert.equal(configuration?.debug, true);
});

test('the Deployment Environment is detected from the hosting platform, never NODE_ENV', () => {
    const environmentFor = (env) =>
        resolve(undefined, { STACKRADAR_INGEST_KEY: KEY, ...env }).configuration
            ?.environment;

    assert.equal(environmentFor({ NODE_ENV: 'production' }), null);
    assert.equal(
        environmentFor({
            VERCEL_ENV: 'preview',
            RAILWAY_ENVIRONMENT_NAME: 'staging',
        }),
        'preview',
    );
    assert.equal(
        environmentFor({ RAILWAY_ENVIRONMENT_NAME: 'staging' }),
        'staging',
    );
    assert.equal(
        environmentFor({
            STACKRADAR_ENVIRONMENT: 'production',
            VERCEL_ENV: 'preview',
        }),
        'production',
    );
});

test('STACKRADAR_DEBUG is on for 1 or true in any case', () => {
    for (const [value, expected] of [
        ['1', true],
        ['TRUE', true],
        [' true ', true],
        ['yes', false],
        ['0', false],
    ]) {
        assert.equal(
            resolve(undefined, { STACKRADAR_DEBUG: value }).debug,
            expected,
            value,
        );
    }
});

test('an invalid Ingest Key is never used, and its warning never shows the key', () => {
    const wrongKey = 'sr_ingest_short-and-secret';
    const fromEnvironment = resolve(undefined, {
        STACKRADAR_INGEST_KEY: wrongKey,
    });
    const fromInit = resolve({ ingestKey: wrongKey }, {});
    const fromInitWithValidVariable = resolve(
        { ingestKey: wrongKey },
        { STACKRADAR_INGEST_KEY: KEY },
    );

    assert.equal(fromEnvironment.configuration, null);
    assert.match(
        fromEnvironment.warnings[0],
        /^the Ingest Key from STACKRADAR_INGEST_KEY is not valid/,
    );
    assert.equal(fromInit.configuration, null);
    assert.match(
        fromInit.warnings[0],
        /^init\(\{ ingestKey \}\) is not a valid Ingest Key/,
    );
    // Like any unusable option, it is dropped and the rest still applies.
    assert.equal(fromInitWithValidVariable.configuration?.ingestKey, KEY);
    for (const warning of [...fromEnvironment.warnings, ...fromInit.warnings]) {
        assert.ok(!warning.includes('secret'));
    }
});

test('options of the wrong type and unknown options are dropped with a warning', () => {
    const { configuration, warnings } = resolve(
        { service: 42, debug: 'yes', servce: 'api', release: 'r1' },
        { STACKRADAR_INGEST_KEY: KEY, STACKRADAR_SERVICE: 'api' },
    );

    assert.equal(configuration?.service, 'api');
    assert.deepEqual(configuration?.release, { value: 'r1', source: 'init' });
    assert.equal(configuration?.debug, false);
    assert.deepEqual(warnings, [
        'init({ service }) must be a string; ignoring it',
        'init({ debug }) must be true or false; ignoring it',
        'init() has no option "servce"; ignoring it',
    ]);
});

test('an argument that is not an options object is ignored with a warning', () => {
    for (const argument of [null, 42, 'api', ['api']]) {
        const { configuration, warnings } = resolve(argument, {
            STACKRADAR_INGEST_KEY: KEY,
        });

        assert.equal(configuration?.ingestKey, KEY);
        assert.deepEqual(warnings, [
            'init() expects an options object; ignoring its argument',
        ]);
    }
});

test('an ingest URL that is not http(s) falls back to the default', () => {
    const withUrl = (ingestUrl) => resolve({ ingestKey: KEY, ingestUrl }, {});
    const withVariable = (url) =>
        resolve(undefined, {
            STACKRADAR_INGEST_KEY: KEY,
            STACKRADAR_INGEST_URL: url,
        });

    assert.equal(
        withUrl('http://localhost:8080/ignored').configuration?.ingestUrl,
        'http://localhost:8080',
    );
    assert.equal(
        withUrl('ftp://example.com').configuration?.ingestUrl,
        'https://ingest.stackradar.com',
    );
    assert.deepEqual(withUrl('not a url').warnings, [
        'init({ ingestUrl }) is not an http(s) URL; ignoring it',
    ]);
    assert.deepEqual(withVariable('not a url').warnings, [
        'STACKRADAR_INGEST_URL is not an http(s) URL; using the default',
    ]);
    assert.equal(
        withVariable('https://ingest.example.com/').configuration?.ingestUrl,
        'https://ingest.example.com',
    );
});

test('a name longer than the server accepts is dropped with a warning', () => {
    const long = 'x'.repeat(256);
    const { configuration, warnings } = resolve(
        { service: long, release: 'x'.repeat(255) },
        {
            STACKRADAR_INGEST_KEY: KEY,
            STACKRADAR_ENVIRONMENT: long,
            STACKRADAR_ARTIFACT: long,
            STACKRADAR_SERVICE: 'api',
        },
    );

    assert.equal(configuration?.service, 'api');
    assert.equal(configuration?.release?.value.length, 255);
    assert.equal(configuration?.environment, null);
    assert.equal(configuration?.artifact, null);
    assert.deepEqual(warnings, [
        'init({ service }) is longer than 255 characters; ignoring it',
        'STACKRADAR_ENVIRONMENT is longer than 255 characters; ignoring it',
        'STACKRADAR_ARTIFACT is longer than 255 characters; ignoring it',
    ]);
});
