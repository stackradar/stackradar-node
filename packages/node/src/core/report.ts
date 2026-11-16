/**
 * The Runtime Report body, built from facts gathered once
 * after start-up. Pure: every input is passed in.
 */

import type { Configuration } from './configuration.js';
import type { Release } from './release.js';
import { REPORTER_VERSION } from './version.js';

export const REPORTER_NAME = '@stackradar/node';

export interface Instance {
    /** A random UUID, new for every process. */
    id: string;
    started_at: string;
}

export interface RuntimeFacts {
    runtime: {
        name: 'node' | 'bun' | 'deno';
        versions: Record<string, string>;
        release: { name: string; lts?: string } | null;
    };
    platform: {
        os: string;
        arch: string;
        os_release: string | null;
        libc: { family: 'glibc'; version: string } | null;
    };
}

export interface PackageError {
    code: string;
    /** Relative to the app root, with `/` separators. */
    path?: string;
}

export type PackageStatus = 'collected' | 'partial' | 'not_found' | 'failed';

/** The `packages` section; the list itself is uploaded separately. */
export interface PackagesSection {
    detector: string;
    status: PackageStatus;
    /** Only for `collected` and `partial`. */
    ecosystem: 'npm' | null;
    inventory_hash: string | null;
    errors?: PackageError[];
}

export interface RuntimeReportBody {
    protocol_version: 1;
    reporter: { name: string; version: string };
    instance: Instance;
    deployment: {
        environment: string | null;
        service: string | null;
        release: Release | null;
        artifact: string | null;
    };
    runtime: RuntimeFacts['runtime'];
    platform: RuntimeFacts['platform'];
    packages: PackagesSection;
}

export interface ReportInputs {
    configuration: Configuration;
    instance: Instance;
    /** The configured Service, else the app's `package.json` name. */
    service: string | null;
    /** The configured Release, else the detected one. */
    release: Release | null;
    facts: RuntimeFacts;
    packages: PackagesSection;
}

export function buildReportBody({
    configuration,
    instance,
    service,
    release,
    facts,
    packages,
}: ReportInputs): RuntimeReportBody {
    return {
        protocol_version: 1,
        reporter: { name: REPORTER_NAME, version: REPORTER_VERSION },
        instance,
        deployment: {
            environment: configuration.environment,
            service,
            release,
            artifact: configuration.artifact,
        },
        runtime: facts.runtime,
        platform: facts.platform,
        packages,
    };
}
