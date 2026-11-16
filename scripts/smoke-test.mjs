// Installs a packed @stackradar/node into a throwaway app and runs it, the
// way a customer would. Run it with the runtime under test; it uses that
// runtime's own installer:
//
//     node scripts/smoke-test.mjs stackradar-node-0.0.0.tgz
//     bun scripts/smoke-test.mjs stackradar-node-0.0.0.tgz
//     deno run -A scripts/smoke-test.mjs stackradar-node-0.0.0.tgz

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [tarball] = process.argv.slice(2);

if (tarball === undefined) {
    throw new Error('Usage: smoke-test.mjs <packed tarball>');
}

const runtime = process.versions.bun
    ? 'bun'
    : process.versions.deno
      ? 'deno'
      : 'node';
const install = {
    node: ['npm', ['install', '--no-audit', '--no-fund']],
    bun: [process.execPath, ['install']],
    deno: [process.execPath, ['install']],
}[runtime];
const run = (file) =>
    runtime === 'deno'
        ? [process.execPath, ['run', '--allow-all', file]]
        : [process.execPath, [file]];

const app = mkdtempSync(join(tmpdir(), 'stackradar-node-smoke-'));

try {
    // Deno's installer leaves a packed tarball dependency empty, so Deno gets
    // the unpacked package as a folder dependency instead.
    let source = resolve(tarball);
    if (runtime === 'deno') {
        execFileSync('tar', ['-xzf', source, '-C', app]);
        source = join(app, 'package');
    }

    writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
            name: 'smoke-app',
            private: true,
            dependencies: { '@stackradar/node': `file:${source}` },
        }),
    );
    writeFileSync(
        join(app, 'main.mjs'),
        `import '@stackradar/node/register';
import { init } from '@stackradar/node';
import { withStackRadar } from '@stackradar/node/next';
const nextConfig = {};
init();
const config = await withStackRadar(nextConfig, { dir: process.cwd() })('phase-development-server', {});
if (config !== nextConfig) throw new Error('withStackRadar changed the config');
console.log('ESM entry points work');
`,
    );
    writeFileSync(
        join(app, 'main.cjs'),
        `require('@stackradar/node/register');
const { init } = require('@stackradar/node');
const { withStackRadar } = require('@stackradar/node/next');
const nextConfig = {};
init();
withStackRadar(nextConfig, { dir: process.cwd() })('phase-development-server', {}).then((config) => {
    if (config !== nextConfig) throw new Error('withStackRadar changed the config');
});
console.log('CommonJS entry points work');
`,
    );

    const [installer, installArgs] = install;
    execFileSync(installer, installArgs, { cwd: app, stdio: 'inherit' });

    for (const file of ['main.mjs', 'main.cjs']) {
        const [command, args] = run(file);
        execFileSync(command, args, { cwd: app, stdio: 'inherit' });
    }

    if (runtime !== 'deno') {
        execFileSync(
            process.execPath,
            [
                join(app, 'node_modules/@stackradar/node/dist/cjs/cli.js'),
                '--version',
            ],
            { cwd: app, stdio: 'inherit' },
        );
    }

    console.log(
        `Smoke test passed on ${runtime} ${process.versions[runtime]}.`,
    );
} finally {
    rmSync(app, { recursive: true, force: true });
}
