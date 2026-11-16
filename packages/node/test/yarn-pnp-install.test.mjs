// Yarn Plug'n'Play against a real install, not a stand-in. CI copies
// yarn-pnp-project/ out of the repository, runs `yarn install --immutable`
// there and then this file with `yarn node`, so the reporter loads Yarn's
// pnpapi as it does in an app. Not part of `npm test`: it needs Yarn and the
// npm registry.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectPackages } from '../dist/esm/node/packages.js';

test(
    "a real Plug'n'Play install gives its production tree",
    {
        skip:
            process.platform === 'darwin' && 'Yarn installs fsevents on macOS',
    },
    async () => {
        assert.ok(
            process.versions.pnp,
            'run with `yarn node` from the installed project',
        );

        const { section, packages } = await collectPackages(process.cwd(), {});

        assert.equal(section.detector, 'yarn-pnp');
        assert.equal(section.status, 'collected');
        // The full install CI runs, as many Plug'n'Play apps ship: not the
        // dev dependency is-number, and not the optional fsevents, which
        // Yarn resolves but does not install on Linux. overlap-lib (local,
        // so not listed) asks for has-flag 4.0.0 and also takes it as a
        // peer; the app's dev dependency has-flag 5.0.1 provides it, so
        // that is what overlap-lib loads. `yarn workspaces focus
        // --production` would install 4.0.0 instead, and the walk would
        // then list that.
        assert.deepEqual(packages, [
            { name: 'debug', version: '4.3.7' },
            { name: 'has-flag', version: '5.0.1' },
            { name: 'kleur', version: '4.1.5' },
            { name: 'ms', version: '2.0.0' },
            { name: 'ms', version: '2.1.3' },
            { name: 'picocolors', version: '1.1.1' },
            { name: 'semver', version: '7.6.3' },
        ]);
    },
);
