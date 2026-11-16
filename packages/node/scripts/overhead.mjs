// Measures the reporter's overhead, by hand, on the
// machine it runs on. Every measurement is a fresh process, sending to a
// receiver in its own process that accepts and discards.
//
// - Start-up: time spent in require() and init(). Collection itself
//   starts at least five seconds later, off the start-up path.
// - Full report: one collection, report and list upload on test/overhead-app
//   (about 1,000 production packages) installed with npm, pnpm and Yarn
//   Plug'n'Play: wall time, CPU time and the peak memory it adds; warm, and
//   with --cold after dropping the page cache.
// - Heartbeat: CPU time of each later report, which reuses the collected
//   body.
//
// Run it on Linux. --cold writes /proc/sys/vm/drop_caches, which needs root,
// so in Docker: docker run --privileged.

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node packages/node/scripts/overhead.mjs [--runs <n>] [--cold]

Installs test/overhead-app with npm, pnpm and Yarn Plug'n'Play, measures the
reporter on each, and prints a Markdown table. Needs the
npm registry and a build (npm run build).

  --runs <n>  Runs per measurement (default 10); the table shows the median
              and the 95th percentile.
  --cold      Also measure with a cold page cache (Linux, as root).
`;

const PNPM = 'pnpm@12.16.1';
const YARN = '@yarnpkg/cli-dist@4.18.1';
const HEARTBEATS = 100;
const KEY = 'sr_ingest_' + 'a'.repeat(43);
const SCRIPT = fileURLToPath(import.meta.url);
const PACKAGE = path.resolve(path.dirname(SCRIPT), '..');
const DIST = path.join(PACKAGE, 'dist');

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'child') {
    // The reporter never keeps a process alive; an app would, so this does.
    const alive = setInterval(() => {}, 1000);
    await child(...rest);
    clearInterval(alive);
} else if (mode === 'receiver') {
    await receiver(Number(rest[0]));
} else {
    await main(process.argv.slice(2));
}

async function main(argv) {
    if (argv.includes('--help')) {
        console.log(HELP);
        return;
    }
    const runs = Number(argv[argv.indexOf('--runs') + 1]) || 10;
    const cold = argv.includes('--cold');

    const work = mkdtempSync(path.join(os.tmpdir(), 'stackradar-overhead-'));
    // A receiver that asks for every list, and one that accepts every report.
    const ingest = await startReceiver(409);
    const accepting = await startReceiver(204);
    try {
        const layouts = install(work);
        const rows = [];
        for (const layout of layouts) {
            const full = (dropCache) =>
                measure(runs, () =>
                    runChild(layout, ['full', ingest.url], dropCache),
                );
            rows.push({
                layout,
                warm: (await full(false)).summary,
                cold: cold ? (await full(true)).summary : null,
            });
        }
        const startup = await measureStartup(layouts[0], runs, ingest.url);
        const heartbeat = await runChild(
            layouts[0],
            ['heartbeat', accepting.url],
            false,
        );
        console.log(report({ runs, cold, layouts, rows, startup, heartbeat }));
    } finally {
        ingest.process.kill();
        accepting.process.kill();
        rmSync(work, { recursive: true, force: true });
    }
}

/** Production installs, scripts off: the walk reads only package.json files. */
function install(work) {
    const source = path.join(PACKAGE, 'test/overhead-app');
    const copy = (name) => {
        const directory = path.join(work, name);
        cpSync(source, directory, { recursive: true });
        return directory;
    };
    const sh = (directory, command, args, env = {}) =>
        execFileSync(command, args, {
            cwd: directory,
            env: { ...process.env, ...env },
            // Progress on stderr; stdout is the table.
            stdio: ['ignore', 2, 2],
        });
    const version = (directory, args) =>
        execFileSync('npm', ['exec', '--yes', ...args, '--', '--version'], {
            cwd: directory,
            encoding: 'utf8',
        }).trim();

    const npm = copy('npm');
    sh(npm, 'npm', [
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
    ]);

    const pnpm = copy('pnpm');
    sh(pnpm, 'npm', [
        'exec',
        '--yes',
        PNPM,
        '--',
        'install',
        '--prod',
        '--ignore-scripts',
    ]);

    const yarn = copy('yarn-pnp');
    writeFileSync(
        path.join(yarn, '.yarnrc.yml'),
        'nodeLinker: pnp\nenableGlobalCache: false\nenableTelemetry: false\nenableScripts: false\n',
    );
    sh(
        yarn,
        'npm',
        ['exec', '--yes', `--package=${YARN}`, '--', 'yarn', 'install'],
        {
            YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
        },
    );

    return [
        {
            name: 'npm',
            manager: `npm ${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`,
            layout: 'hoisted',
            directory: npm,
        },
        {
            name: 'pnpm',
            manager: `pnpm ${version(pnpm, [PNPM])}`,
            layout: 'isolated',
            directory: pnpm,
        },
        {
            name: 'yarn-pnp',
            manager: `Yarn ${version(yarn, [`--package=${YARN}`, 'yarn'])}`,
            layout: "Plug'n'Play",
            directory: yarn,
        },
    ];
}

/** One measurement in a fresh process; under Plug'n'Play through `yarn node`. */
async function runChild(layout, args, dropCache) {
    if (dropCache) {
        execFileSync('sh', ['-c', 'sync && echo 3 > /proc/sys/vm/drop_caches']);
    }
    const [command, commandArgs] =
        layout.name === 'yarn-pnp'
            ? [
                  'npm',
                  [
                      'exec',
                      '--yes',
                      `--package=${YARN}`,
                      '--',
                      'yarn',
                      'node',
                      SCRIPT,
                      'child',
                      ...args,
                  ],
              ]
            : [process.execPath, ['--expose-gc', SCRIPT, 'child', ...args]];
    const output = execFileSync(command, commandArgs, {
        cwd: layout.directory,
        encoding: 'utf8',
    });

    return JSON.parse(output.trim().split('\n').at(-1));
}

async function measure(runs, once) {
    const results = [];
    for (let run = 0; run < runs; run += 1) {
        results.push(await once());
    }
    const summary = {};
    for (const key of Object.keys(results[0])) {
        const values = results.map((result) => result[key]);
        summary[key] =
            typeof values[0] === 'number'
                ? {
                      median: percentile(values, 0.5),
                      p95: percentile(values, 0.95),
                  }
                : values[0];
    }

    return { summary };
}

/** require() and init(), timed inside a fresh process each run. */
async function measureStartup(layout, runs, ingestUrl) {
    const timed = (code) =>
        Number(
            execFileSync(
                process.execPath,
                [
                    '-e',
                    `const t = performance.now(); ${code}; console.log(performance.now() - t);`,
                ],
                {
                    cwd: layout.directory,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        STACKRADAR_INGEST_KEY: KEY,
                        STACKRADAR_INGEST_URL: ingestUrl,
                    },
                },
            ),
        );
    const reporter = [];
    for (let run = 0; run < runs; run += 1) {
        reporter.push(
            timed(
                `require(${JSON.stringify(path.join(DIST, 'cjs/index.js'))}).init({ service: 'api' })`,
            ),
        );
    }

    return {
        median: percentile(reporter, 0.5),
        p95: percentile(reporter, 0.95),
    };
}

/** Runs in the measured process. */
async function child(kind, ingestUrl) {
    const load = (file) => import(path.join(DIST, 'esm', file));
    const [{ collect, userAgent }, { createReporting }, { createSend }] =
        await Promise.all([
            load('node/start.js'),
            load('core/lifecycle.js'),
            load('node/transport.js'),
        ]);
    const configuration = {
        ingestKey: KEY,
        environment: 'production',
        service: null,
        release: null,
        artifact: null,
        root: process.cwd(),
        debug: false,
        ingestUrl,
    };
    const instance = {
        id: crypto.randomUUID(),
        started_at: new Date().toISOString(),
    };
    const reporting = (collection) =>
        createReporting({
            body: collection.body,
            packages: collection.packages,
            send: createSend({
                ingestUrl,
                ingestKey: KEY,
                userAgent: userAgent(collection.body),
            }),
            log: () => {},
        });

    const rssBefore = process.resourceUsage().maxRSS;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const collection = await collect({
        configuration,
        env: {},
        entry: undefined,
        cwd: process.cwd(),
        instance,
    });
    const walked = performance.now();

    if (kind === 'full') {
        // The receiver answers 409, so the list is uploaded too.
        await reporting(collection).tick();
        const cpu = process.cpuUsage(cpuBefore);
        console.log(
            JSON.stringify({
                packages: collection.packages?.length ?? 0,
                detector: collection.body.packages.detector,
                status: collection.body.packages.status,
                walkMs: walked - started,
                totalMs: performance.now() - started,
                cpuMs: (cpu.user + cpu.system) / 1000,
                peakRssMb: (process.resourceUsage().maxRSS - rssBefore) / 1024,
            }),
        );
        return;
    }

    // Heartbeats: the same body again; the receiver answers 204.
    const heartbeat = reporting(collection);
    globalThis.gc?.();
    const cpu = [];
    for (let beat = 0; beat < HEARTBEATS; beat += 1) {
        const before = process.cpuUsage();
        await heartbeat.tick();
        const used = process.cpuUsage(before);
        cpu.push((used.user + used.system) / 1000);
    }
    globalThis.gc?.();
    const heapAfterFirst = process.memoryUsage().heapUsed;
    for (let beat = 0; beat < HEARTBEATS; beat += 1) {
        await heartbeat.tick();
    }
    globalThis.gc?.();
    console.log(
        JSON.stringify({
            heartbeats: HEARTBEATS,
            cpuMs: { median: percentile(cpu, 0.5), p95: percentile(cpu, 0.95) },
            heapGrowthKb:
                (process.memoryUsage().heapUsed - heapAfterFirst) / 1024,
        }),
    );
}

/** Accepts and discards; answers reports with `reportStatus`, uploads with 204. */
async function receiver(reportStatus) {
    const server = createServer((request, response) => {
        request.resume();
        request.on('end', () => {
            if (request.method === 'POST' && reportStatus === 409) {
                response
                    .writeHead(409, { 'content-type': 'application/json' })
                    .end('{"code":"unknown_inventory"}');
            } else {
                response.writeHead(204).end();
            }
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    console.log(server.address().port);
}

async function startReceiver(reportStatus) {
    const receiverProcess = spawn(
        process.execPath,
        [SCRIPT, 'receiver', String(reportStatus)],
        {
            stdio: ['ignore', 'pipe', 'inherit'],
        },
    );
    const [port] = await once(receiverProcess.stdout, 'data');

    return {
        process: receiverProcess,
        url: `http://127.0.0.1:${String(port).trim()}`,
    };
}

function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[
        Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ];
}

function report({ runs, cold, layouts, rows, startup, heartbeat }) {
    const { version } = JSON.parse(
        readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'),
    );
    let commit = 'unknown';
    try {
        commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: PACKAGE,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        // A copy without git, or a repository git does not trust here.
    }
    const ms = ({ median, p95 }) =>
        `${median.toFixed(1)} ms (p95 ${p95.toFixed(1)})`;
    const mb = ({ median }) => `${median.toFixed(1)} MB`;
    const cpu = os.cpus();

    return [
        `- **Date:** ${new Date().toISOString().slice(0, 10)}`,
        `- **Reporter:** ${version} at \`${commit}\``,
        `- **Node.js:** ${process.version}`,
        `- **Machine:** ${os.type()} ${os.release()} ${os.arch()}, ${cpu[0]?.model.trim()} × ${cpu.length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
        `- **Package managers:** ${layouts.map(({ manager }) => manager).join(', ')}`,
        `- **Runs:** ${runs} per measurement, each in a fresh process; median, with the 95th percentile in brackets`,
        '',
        '| Install | Packages | Detector | Walk, warm | Report and upload, warm | CPU time, warm | Peak memory added, warm |' +
            (cold ? ' Walk, cold |' : ''),
        '|---|---|---|---|---|---|---|' + (cold ? '---|' : ''),
        ...rows.map(
            ({ layout, warm, cold: coldRun }) =>
                `| ${layout.manager}, ${layout.layout} | ${warm.packages.median} | \`${warm.detector}\` | ${ms(warm.walkMs)} | ${ms(warm.totalMs)} | ${ms(warm.cpuMs)} | ${mb(warm.peakRssMb)} |` +
                (coldRun ? ` ${ms(coldRun.walkMs)} |` : ''),
        ),
        '',
        `- **Start-up:** \`require()\` and \`init()\` take ${ms(startup)}; collection starts at least five seconds later.`,
        `- **Heartbeat:** ${ms(heartbeat.cpuMs)} of CPU time per report, over ${heartbeat.heartbeats} reports; heap ${heartbeat.heapGrowthKb >= 0 ? '+' : ''}${heartbeat.heapGrowthKb.toFixed(0)} KB over ${heartbeat.heartbeats} more.`,
    ].join('\n');
}
