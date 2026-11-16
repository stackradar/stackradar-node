// Release detection from .git, on fixture
// repositories built in a temporary directory.

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

import { releaseFromGit } from '../dist/esm/node/git.js';

const SHA1 = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const SHA256 = 'a'.repeat(64);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-git-')));
after(() => rmSync(base, { recursive: true, force: true }));

function tree(name, files) {
    const root = join(base, name);
    mkdirSync(root, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }

    return root;
}

test('a branch is followed to its ref file', async () => {
    const repo = tree('loose', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/refs/heads/main': `${SHA1}\n`,
    });

    assert.deepEqual(await releaseFromGit(repo), {
        value: SHA1,
        source: 'git',
    });
});

test('a branch only in packed-refs is found there', async () => {
    const repo = tree('packed', {
        '.git/HEAD': 'ref: refs/heads/release/2.4\n',
        '.git/packed-refs': [
            '# pack-refs with: peeled fully-peeled sorted',
            `${'b'.repeat(40)} refs/heads/main`,
            `${SHA1} refs/heads/release/2.4`,
            `^${'c'.repeat(40)}`,
        ].join('\n'),
    });

    assert.deepEqual(await releaseFromGit(repo), {
        value: SHA1,
        source: 'git',
    });
});

test('a detached HEAD gives its commit, SHA-1 or SHA-256', async () => {
    for (const [name, commit] of [
        ['detached-sha1', SHA1],
        ['detached-sha256', SHA256],
    ]) {
        const repo = tree(name, { '.git/HEAD': `${commit}\n` });

        assert.deepEqual(await releaseFromGit(repo), {
            value: commit,
            source: 'git',
        });
    }
});

test('an app inside a monorepo finds the .git above it', async () => {
    const repo = tree('monorepo', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/refs/heads/main': SHA1,
        'apps/api/package.json': '{"name":"api"}',
    });

    assert.deepEqual(await releaseFromGit(join(repo, 'apps/api')), {
        value: SHA1,
        source: 'git',
    });
});

test('branch names with punctuation and Unicode are followed, loose or packed', async () => {
    for (const branch of ['release/1.0+hotfix', 'release/é', 'feat/a,b=c%d']) {
        const ref = `refs/heads/${branch}`;
        const loose = tree(`loose-${branch}`, {
            '.git/HEAD': `ref: ${ref}\n`,
            [`.git/${ref}`]: `${SHA1}\n`,
        });
        const packed = tree(`packed-${branch}`, {
            '.git/HEAD': `ref: ${ref}\n`,
            '.git/packed-refs': `${SHA1} ${ref}\n`,
        });

        for (const repo of [loose, packed]) {
            assert.deepEqual(
                await releaseFromGit(repo),
                { value: SHA1, source: 'git' },
                repo,
            );
        }
    }
});

test('names git check-ref-format rejects are not read, even when the file exists', async () => {
    for (const [index, ref] of [
        'refs/heads/.hidden',
        'refs/heads/x.lock',
        'refs/heads/a~1',
        'refs/heads/a@{1}',
        'refs/heads/a.',
        'refs/heads/a b',
    ].entries()) {
        const repo = tree(`rejected-${index}`, {
            '.git/HEAD': `ref: ${ref}\n`,
            [`.git/${ref}`]: SHA1,
            '.git/packed-refs': `${SHA1} ${ref}\n`,
        });

        assert.equal(await releaseFromGit(repo), null, ref);
    }
});

test('anything but a full commit hash gives no Release', async () => {
    const cases = {
        'no-git': {},
        'git-file': { '.git': 'gitdir: ../elsewhere/.git\n' },
        'unborn-branch': { '.git/HEAD': 'ref: refs/heads/main\n' },
        'short-hash': { '.git/HEAD': '9f8e7d6\n' },
        'escaping-ref': {
            '.git/HEAD': 'ref: refs/../../secret\n',
            secret: SHA1,
        },
        'not-a-ref': { '.git/HEAD': 'ref: HEAD\n' },
    };

    for (const [name, files] of Object.entries(cases)) {
        assert.equal(await releaseFromGit(tree(name, files)), null, name);
    }
});
