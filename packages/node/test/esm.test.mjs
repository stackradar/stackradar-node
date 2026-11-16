// Runs against the built ESM entry points, resolved through the package's
// own `exports`, on every supported Node.js version.

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('init can be imported and called without throwing', async () => {
    const { init } = await import('@stackradar/node');

    assert.equal(init(), undefined);
});

test('the register entry point can be imported', async () => {
    await import('@stackradar/node/register');
});

test('withStackRadar gives a Next.js config function that leaves other phases alone', async () => {
    const { withStackRadar } = await import('@stackradar/node/next');
    const nextConfig = { output: 'standalone' };
    const config = withStackRadar(nextConfig, { dir: process.cwd() });

    assert.equal(await config('phase-development-server', {}), nextConfig);
});
