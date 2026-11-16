import { setTimeout } from 'node:timers';
import { isMainThread } from 'node:worker_threads';

import type { InitOptions } from './core/configuration.js';
import { createReporter, type Reporter } from './core/reporter.js';
import { writeToStderr } from './node/stderr.js';

export type { InitOptions };

/** Start-up settles for about 5 seconds; a random delay spreads a fleet's first reports. */
const SETTLE_MILLISECONDS = 5_000;
const SPREAD_MILLISECONDS = 30_000;

/**
 * One reporter per process, even when an app loads both the ESM and the
 * CommonJS build, for example `--require @stackradar/node/register` and
 * `import { init } from '@stackradar/node'`.
 */
const SHARED_REPORTER = Symbol.for('@stackradar/node.reporter.v1');

function sharedReporter(): Reporter {
    const holder = globalThis as { [SHARED_REPORTER]?: Reporter };

    return (holder[SHARED_REPORTER] ??= createReporter({
        env: process.env,
        write: writeToStderr,
        schedule: (begin) => {
            setTimeout(
                begin,
                SETTLE_MILLISECONDS +
                    Math.floor(Math.random() * SPREAD_MILLISECONDS),
            ).unref();
        },
        // Loaded when the reporter starts, seconds later, so require() and
        // init() load almost nothing while the app starts.
        start: async (configuration, log) => {
            const { start } = await import('./node/start.js');
            await start(configuration, log);
        },
    }));
}

/**
 * Starts the reporter. Options override environment variables, and calling
 * it again before the reporter starts adds options. It never throws into the
 * app, and without an Ingest Key it does nothing. In a worker thread it does
 * nothing either: threads share the process and its packages, and
 * `NODE_OPTIONS` loads the reporter in each of them.
 */
export function init(options?: InitOptions): void {
    if (!isMainThread) {
        return;
    }

    try {
        sharedReporter().init(options);
    } catch {
        // Never into the app.
    }
}
