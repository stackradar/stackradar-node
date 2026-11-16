// Every fixture from a real install (scripts/make-fixtures.mjs) must give
// its package manager's own production list. Each layout is copied out of
// the repository first: inside it, a missing package would resolve to the
// repository's own node_modules.

import assert from 'node:assert/strict';
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectPackages } from '../dist/esm/node/packages.js';

const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const STANDALONE = { __NEXT_PRIVATE_STANDALONE_CONFIG: '{}' };

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-fixtures-')));
after(() => rmSync(base, { recursive: true, force: true }));

const fixtures = readdirSync(FIXTURES).filter((name) =>
    existsSync(join(FIXTURES, name, 'fixture.json')),
);

test('every fixture is checked', () => {
    assert.equal(fixtures.length, 19);
});

for (const name of fixtures) {
    test(name, async () => {
        const fixture = JSON.parse(
            readFileSync(join(FIXTURES, name, 'fixture.json'), 'utf8'),
        );
        const layout = join(base, name);
        cpSync(join(FIXTURES, name, 'layout'), layout, {
            recursive: true,
            verbatimSymlinks: true,
        });

        for (const app of fixture.apps) {
            const { section, packages } = await collectPackages(
                join(layout, app.appRoot),
                name === 'nextjs-standalone' ? STANDALONE : {},
            );

            assert.equal(section.status, app.status, app.appRoot);
            assert.deepEqual(packages, app.packages, app.appRoot);
        }
    });
}
