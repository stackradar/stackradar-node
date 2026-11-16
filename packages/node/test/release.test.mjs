// Release detection from CI and hosting commit variables.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { releaseFromCommitVariables } from '../dist/esm/core/release.js';

const SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

test('without a commit variable there is no Release', () => {
    assert.equal(releaseFromCommitVariables({ NODE_ENV: 'production' }), null);
});

test('each platform variable is recognised and named as the source', () => {
    for (const name of [
        'GITHUB_SHA',
        'CI_COMMIT_SHA',
        'VERCEL_GIT_COMMIT_SHA',
        'RENDER_GIT_COMMIT',
        'HEROKU_SLUG_COMMIT',
        'GIT_COMMIT',
    ]) {
        assert.deepEqual(releaseFromCommitVariables({ [name]: SHA }), {
            value: SHA,
            source: `env:${name}`,
        });
    }
});

test('a platform-specific variable wins over a generic one', () => {
    assert.deepEqual(
        releaseFromCommitVariables({
            GIT_COMMIT: 'generic',
            SOURCE_VERSION: 'generic',
            RAILWAY_GIT_COMMIT_SHA: SHA,
        }),
        { value: SHA, source: 'env:RAILWAY_GIT_COMMIT_SHA' },
    );
});

test('empty values, unfilled placeholders and over-long values are skipped', () => {
    assert.deepEqual(
        releaseFromCommitVariables({
            GITHUB_SHA: ' ',
            CI_COMMIT_SHA: 'CI_COMMIT_SHA',
            BITBUCKET_COMMIT: 'x'.repeat(256),
            GIT_COMMIT: ` ${SHA}\n`,
        }),
        { value: SHA, source: 'env:GIT_COMMIT' },
    );
});
