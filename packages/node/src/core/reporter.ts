/**
 * The reporter's state for one process. `init()` may be called more than
 * once, for example by `register` and by the app's own setup file: each
 * call's options are validated and merge, later ones winning, until the
 * reporter starts once start-up has settled. An option that is absent or
 * unusable never erases an earlier one. Nothing here may throw into the app.
 */

import {
    resolveConfiguration,
    validateOptions,
    type Configuration,
    type Environment,
    type ValidOptions,
} from './configuration.js';

export interface ReporterDependencies {
    env: Environment;
    /** Writes one line for the app's operators, such as stderr. */
    write: (line: string) => void;
    /** Calls `start` once start-up has settled, without keeping the process alive. */
    schedule: (start: () => void) => void;
    /** The work after start-up: collecting and sending. */
    start: (
        configuration: Configuration,
        log: (message: string) => void,
    ) => Promise<void>;
}

export interface Reporter {
    init(options?: unknown): void;
}

export function createReporter(dependencies: ReporterDependencies): Reporter {
    let options: ValidOptions = {};
    let calls = 0;
    let scheduled = false;
    let started = false;
    let debug = false;
    const warned = new Set<string>();

    const write = (line: string): void => {
        try {
            dependencies.write(line);
        } catch {
            // Nowhere left to report to.
        }
    };
    const log = (message: string): void => {
        if (debug) {
            write(message);
        }
    };

    function start(): void {
        started = true;
        const resolution = resolveConfiguration(options, dependencies.env);
        debug = resolution.debug;

        if (resolution.configuration === null) {
            log('no valid Ingest Key when starting; not reporting');
            return;
        }

        log('starting');
        dependencies
            .start(resolution.configuration, log)
            .catch((error: unknown) => {
                log(`stopped after an error: ${describe(error)}`);
            });
    }

    function init(given: unknown): void {
        calls += 1;

        if (started) {
            log('init() was called after the reporter started; ignoring it');
            return;
        }

        const validation = validateOptions(given);
        options = { ...options, ...validation.options };

        const resolution = resolveConfiguration(options, dependencies.env);
        debug = resolution.debug;
        const warnings = [...validation.warnings, ...resolution.warnings];

        const fresh = warnings.filter((warning) => !warned.has(warning));
        fresh.forEach((warning) => warned.add(warning));
        if (fresh.length > 0) {
            write(fresh.join('; '));
        }

        if (calls > 1) {
            log(
                'init() was called again before the reporter started; options merged',
            );
        }

        if (resolution.configuration === null) {
            log('no valid Ingest Key; not reporting');
            return;
        }

        log(`configured: ${summarize(resolution.configuration)}`);

        if (!scheduled) {
            scheduled = true;
            dependencies.schedule(() => {
                try {
                    start();
                } catch (error) {
                    log(`stopped after an error: ${describe(error)}`);
                }
            });
        }
    }

    return {
        init(given?: unknown): void {
            try {
                init(given);
            } catch (error) {
                log(`init() failed: ${describe(error)}`);
            }
        },
    };
}

/** Everything but the Ingest Key, which is never logged. */
function summarize(configuration: Configuration): string {
    const shown = (value: string | null): string => value ?? 'not set';

    return [
        `environment=${shown(configuration.environment)}`,
        `service=${shown(configuration.service)}`,
        `release=${shown(configuration.release?.value ?? null)}`,
        `artifact=${shown(configuration.artifact)}`,
        `root=${configuration.root ?? 'detected'}`,
    ].join(' ');
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
