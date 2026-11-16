// Runtime and platform facts from the runtime running the tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runtimeFacts } from '../dist/esm/node/runtime.js';

test('the runtime is named and reports its versions within the server limits', () => {
    const { runtime } = runtimeFacts();
    const versions = Object.entries(runtime.versions);

    assert.equal(runtime.name, 'node');
    assert.equal(runtime.versions.node, process.versions.node);
    assert.ok(versions.length > 0 && versions.length <= 200);
    for (const [, version] of versions) {
        assert.equal(typeof version, 'string');
        assert.ok(version.length <= 100, version);
    }
    assert.equal(runtime.release?.name, 'node');
});

test('the platform names the operating system and architecture', () => {
    const { platform } = runtimeFacts();

    assert.equal(platform.os, process.platform);
    assert.equal(platform.arch, process.arch);
    assert.equal(typeof platform.os_release, 'string');
});

test('libc is the glibc version on glibc Linux, otherwise null', () => {
    const { libc } = runtimeFacts().platform;
    const glibc =
        process.platform === 'linux'
            ? process.report.getReport().header.glibcVersionRuntime
            : undefined;

    assert.deepEqual(
        libc,
        glibc === undefined ? null : { family: 'glibc', version: glibc },
    );
});
