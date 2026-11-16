// Drafts a release: sets the package version and adds a CHANGELOG section
// listing every commit since the last release tag, one line per merged pull
// request. The section is edited by hand in the release pull request.
//
//   node scripts/prepare-release.mjs 0.2.0

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHANGELOG = 'packages/node/CHANGELOG.md';
const version = process.argv[2] ?? '';

// npm would turn 01.2.3 into 1.2.3, leaving a CHANGELOG heading no release
// finds, so leading zeros are refused.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(
        'usage: node scripts/prepare-release.mjs <major.minor.patch>',
    );
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let range = 'HEAD';
try {
    range = `${git('describe', '--tags', '--abbrev=0', '--match', 'v*')}..HEAD`;
} catch {
    // No release yet: every commit.
}
const subjects = git('log', '--format=%s', range).split('\n').filter(Boolean);

execFileSync(
    'npm',
    [
        'version',
        version,
        '--no-git-tag-version',
        '--workspace',
        'packages/node',
    ],
    { stdio: 'inherit' },
);

const date = new Date().toISOString().slice(0, 10);
const section = `## [${version}] - ${date}\n\n${subjects.map((subject) => `- ${subject}`).join('\n')}\n\n`;
const changelog = readFileSync(CHANGELOG, 'utf8');
const latest = changelog.indexOf('\n## ');
writeFileSync(
    CHANGELOG,
    latest === -1
        ? `${changelog.trimEnd()}\n\n${section}`
        : changelog.slice(0, latest + 1) +
              section +
              changelog.slice(latest + 1),
);
