/**
 * What the reporter does once start-up has settled: gather the facts and
 * the package list, build the Runtime Report, send it, and send it again
 * at every heartbeat.
 */

import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';

import type { Configuration, Environment } from '../core/configuration.js';
import { releaseFromCommitVariables } from '../core/release.js';
import {
    buildReportBody,
    type Instance,
    type RuntimeReportBody,
} from '../core/report.js';
import type { Package } from '../core/inventory.js';
import { createReporting, HEARTBEAT_MILLISECONDS } from '../core/lifecycle.js';
import { REPORTER_NAME } from '../core/report.js';
import { REPORTER_VERSION } from '../core/version.js';
import { appName, resolveAppRoot, type AppRoot } from './app-root.js';
import { releaseFromGit } from './git.js';
import { collectPackages } from './packages.js';
import { runtimeFacts } from './runtime.js';
import { createSend } from './transport.js';

export interface CollectionInputs {
    configuration: Configuration;
    env: Environment;
    /** `process.argv[1]`. */
    entry: string | undefined;
    cwd: string;
    instance: Instance;
}

export interface Collection {
    appRoot: AppRoot | null;
    body: RuntimeReportBody;
    /** The list behind `packages.inventory_hash`, or `null` when none was collected. */
    packages: Package[] | null;
}

export async function collect({
    configuration,
    env,
    entry,
    cwd,
    instance,
}: CollectionInputs): Promise<Collection> {
    const appRoot = await resolveAppRoot({
        configured: configuration.root,
        entry,
        cwd,
    });
    const service =
        configuration.service ??
        (appRoot === null ? null : await appName(appRoot.path));
    const release =
        configuration.release ??
        releaseFromCommitVariables(env) ??
        (appRoot === null ? null : await releaseFromGit(appRoot.path));
    const packages = await collectPackages(appRoot?.path ?? null, env);

    return {
        appRoot,
        body: buildReportBody({
            configuration,
            instance,
            service,
            release,
            facts: runtimeFacts(),
            packages: packages.section,
        }),
        packages: packages.packages,
    };
}

/** The reporter, its version and the runtime. */
export function userAgent(body: RuntimeReportBody): string {
    const { name, versions } = body.runtime;

    return `${REPORTER_NAME}/${REPORTER_VERSION} (${name} ${versions[name] ?? 'unknown'})`;
}

export async function start(
    configuration: Configuration,
    log: (message: string) => void,
): Promise<void> {
    const { appRoot, body, packages } = await collect({
        configuration,
        env: process.env,
        entry: process.argv[1],
        cwd: process.cwd(),
        instance: {
            id: randomUUID(),
            started_at: new Date(
                Date.now() - process.uptime() * 1000,
            ).toISOString(),
        },
    });

    log(
        appRoot === null
            ? 'no app root found: no package.json with a name or dependencies'
            : `app root: ${appRoot.path} (${appRoot.source})`,
    );
    if (packages !== null) {
        log(`package list: ${packages.length} packages`);
    }

    const reporting = createReporting({
        body,
        packages,
        send: createSend({
            ingestUrl: configuration.ingestUrl,
            ingestKey: configuration.ingestKey,
            userAgent: userAgent(body),
            // Only in debug mode, so nothing is formatted otherwise.
            ...(configuration.debug ? { log } : {}),
        }),
        log,
    });

    await reporting.tick();
    if (reporting.stopped) {
        return;
    }

    // The same report at every heartbeat; the timer never keeps the
    // process alive.
    const heartbeat = setInterval(() => {
        void reporting.tick().then(() => {
            if (reporting.stopped) {
                clearInterval(heartbeat);
            }
        });
    }, HEARTBEAT_MILLISECONDS);
    heartbeat.unref();
}
