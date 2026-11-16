// Runs against the built CommonJS entry points, resolved through the
// package's own `exports`, on every supported Node.js version.

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('init can be required and called without throwing', () => {
    const { init } = require('@stackradar/node');

    assert.equal(init(), undefined);
});

test('the register entry point can be required', () => {
    require('@stackradar/node/register');
});

test('withStackRadar gives a Next.js config function that leaves other phases alone', async () => {
    const { withStackRadar } = require('@stackradar/node/next');
    const nextConfig = { output: 'standalone' };
    const config = withStackRadar(nextConfig, { dir: process.cwd() });

    assert.equal(await config('phase-development-server', {}), nextConfig);
});
