/**
 * Runtime and platform facts, read once after start-up.
 */

import { release as osRelease } from 'node:os';

import type { RuntimeFacts } from '../core/report.js';

/** What the server accepts in `runtime.versions`. */
const MAX_VERSIONS = 200;
const MAX_VERSION_LENGTH = 100;

export function runtimeFacts(): RuntimeFacts {
    return {
        runtime: {
            name: process.versions.bun
                ? 'bun'
                : process.versions.deno
                  ? 'deno'
                  : 'node',
            versions: versions(),
            release: runtimeRelease(),
        },
        platform: {
            os: process.platform,
            arch: process.arch,
            os_release: operatingSystemRelease(),
            libc: glibc(),
        },
    };
}

/** Every version string the runtime reports, within the server's limits. */
function versions(): Record<string, string> {
    return Object.fromEntries(
        Object.entries(process.versions)
            .filter(
                (entry): entry is [string, string] =>
                    typeof entry[1] === 'string' &&
                    entry[1] !== '' &&
                    entry[1].length <= MAX_VERSION_LENGTH,
            )
            .slice(0, MAX_VERSIONS),
    );
}

function runtimeRelease(): RuntimeFacts['runtime']['release'] {
    const { name, lts } = (process.release ?? {}) as {
        name?: unknown;
        lts?: unknown;
    };

    if (typeof name !== 'string') {
        return null;
    }

    return typeof lts === 'string' ? { name, lts } : { name };
}

function operatingSystemRelease(): string | null {
    try {
        return osRelease();
    } catch {
        return null;
    }
}

/**
 * The glibc version from the header of Node.js's diagnostic report. The
 * report also holds environment variables, so nothing else is read from it.
 * Other C libraries, such as Alpine's musl, give `null`.
 */
function glibc(): RuntimeFacts['platform']['libc'] {
    if (process.platform !== 'linux') {
        return null;
    }

    try {
        const report: unknown = process.report?.getReport();
        const parsed: unknown =
            typeof report === 'string' ? JSON.parse(report) : report;
        const version = (
            parsed as { header?: { glibcVersionRuntime?: unknown } }
        )?.header?.glibcVersionRuntime;

        return typeof version === 'string' && version !== ''
            ? { family: 'glibc', version }
            : null;
    } catch {
        return null;
    }
}
