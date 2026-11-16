/**
 * Resolves the reporter's configuration from `init()` options, then
 * environment variables, then detection. Pure, so it runs the
 * same in every runtime and is tested without a process.
 */

import type { Release } from './release.js';

/** Options accepted by `init()`. Each one can also be set by environment variable. */
export interface InitOptions {
    /** The Project's Ingest Key. Without one the reporter does nothing. */
    ingestKey?: string;
    /** The Deployment Environment, such as `production`. */
    environment?: string;
    /** The Service, such as `api`. */
    service?: string;
    /** The Release this Instance runs, usually a commit SHA. */
    release?: string;
    /** The image digest or build ID of the running build. */
    artifact?: string;
    /** The app root: the directory of the running app's `package.json`. */
    root?: string;
    /** Logs reporter activity to stderr. */
    debug?: boolean;
    /** Overrides the ingest address, for testing. Not part of the supported configuration. */
    ingestUrl?: string;
}

export interface Configuration {
    ingestKey: string;
    environment: string | null;
    service: string | null;
    /** From `init()` or `STACKRADAR_RELEASE`; detected later when absent. */
    release: Release | null;
    artifact: string | null;
    root: string | null;
    debug: boolean;
    ingestUrl: string;
}

export interface Resolution {
    /** `null` when the reporter must do nothing: no Ingest Key, or an invalid one. */
    configuration: Configuration | null;
    debug: boolean;
    /** Problems the app should see. They never contain the Ingest Key. */
    warnings: string[];
}

/**
 * `init()` options that passed validation: trimmed, non-empty and valid.
 * An option is absent when it was not given or was not usable, so merging
 * validated options never erases an earlier value.
 */
export type ValidOptions = InitOptions;

export interface Validation {
    options: ValidOptions;
    warnings: string[];
}

export type Environment = Readonly<Record<string, string | undefined>>;

type StringOption = Exclude<keyof InitOptions, 'debug'>;

/**
 * The longest Deployment Environment, Service, Release or artifact the
 * server accepts. A longer value would make it refuse the whole report.
 */
export const MAX_NAME_LENGTH = 255;

const NAMES: ReadonlySet<string> = new Set([
    'environment',
    'service',
    'release',
    'artifact',
]);

const DEFAULT_INGEST_URL = 'https://ingest.stackradar.com';
const INGEST_KEY = /^sr_ingest_[0-9A-Za-z]{43}$/;
const INGEST_KEY_FORMAT = 'sr_ingest_ followed by 43 letters and digits';

const ENVIRONMENT_VARIABLES: Record<StringOption, string> = {
    ingestKey: 'STACKRADAR_INGEST_KEY',
    environment: 'STACKRADAR_ENVIRONMENT',
    service: 'STACKRADAR_SERVICE',
    release: 'STACKRADAR_RELEASE',
    artifact: 'STACKRADAR_ARTIFACT',
    root: 'STACKRADAR_ROOT',
    ingestUrl: 'STACKRADAR_INGEST_URL',
};

/** Hosting platforms that name the Deployment Environment. Never `NODE_ENV`. */
const DETECTED_ENVIRONMENTS = ['VERCEL_ENV', 'RAILWAY_ENVIRONMENT_NAME'];

/** Checks one `init()` argument. Unusable options are dropped with a warning. */
export function validateOptions(options: unknown): Validation {
    const valid: ValidOptions = {};
    const warnings: string[] = [];

    if (options === undefined) {
        return { options: valid, warnings };
    }

    if (
        typeof options !== 'object' ||
        options === null ||
        Array.isArray(options)
    ) {
        warnings.push(
            'init() expects an options object; ignoring its argument',
        );
        return { options: valid, warnings };
    }

    for (const [name, given] of Object.entries(options)) {
        if (given === undefined) {
            continue;
        }

        if (name === 'debug') {
            if (typeof given === 'boolean') {
                valid.debug = given;
            } else {
                warnings.push(
                    'init({ debug }) must be true or false; ignoring it',
                );
            }
        } else if (!isStringOption(name)) {
            warnings.push(`init() has no option "${name}"; ignoring it`);
        } else if (typeof given !== 'string') {
            warnings.push(`init({ ${name} }) must be a string; ignoring it`);
        } else if (given.trim() !== '') {
            const value = given.trim();

            if (NAMES.has(name) && value.length > MAX_NAME_LENGTH) {
                warnings.push(
                    `init({ ${name} }) is longer than ${MAX_NAME_LENGTH} characters; ignoring it`,
                );
            } else if (name === 'ingestKey' && !INGEST_KEY.test(value)) {
                warnings.push(
                    `init({ ingestKey }) is not a valid Ingest Key (expected ${INGEST_KEY_FORMAT}); ignoring it`,
                );
            } else if (name === 'ingestUrl') {
                const url = ingestOrigin(value);
                if (url === null) {
                    warnings.push(
                        'init({ ingestUrl }) is not an http(s) URL; ignoring it',
                    );
                } else {
                    valid.ingestUrl = url;
                }
            } else {
                valid[name] = value;
            }
        }
    }

    return { options: valid, warnings };
}

export function resolveConfiguration(
    options: ValidOptions,
    env: Environment,
): Resolution {
    const warnings: string[] = [];
    const named = (variable: string): string | null => {
        const fromVariable = fromEnvironment(env, variable);
        if (fromVariable !== null && fromVariable.length > MAX_NAME_LENGTH) {
            warnings.push(
                `${variable} is longer than ${MAX_NAME_LENGTH} characters; ignoring it`,
            );
            return null;
        }

        return fromVariable;
    };
    const value = (name: StringOption): string | null =>
        options[name] ??
        (NAMES.has(name)
            ? named(ENVIRONMENT_VARIABLES[name])
            : fromEnvironment(env, ENVIRONMENT_VARIABLES[name]));
    const debug = options.debug ?? isOn(env.STACKRADAR_DEBUG);

    const ingestKey = value('ingestKey');
    if (ingestKey === null) {
        return { configuration: null, debug, warnings };
    }

    if (!INGEST_KEY.test(ingestKey)) {
        warnings.push(
            `the Ingest Key from ${ENVIRONMENT_VARIABLES.ingestKey} is not valid (expected ${INGEST_KEY_FORMAT}); not reporting`,
        );
        return { configuration: null, debug, warnings };
    }

    return {
        configuration: {
            ingestKey,
            environment:
                value('environment') ??
                DETECTED_ENVIRONMENTS.map(named).find(
                    (detected) => detected !== null,
                ) ??
                null,
            service: value('service'),
            release: release(options, value('release')),
            artifact: value('artifact'),
            root: value('root'),
            debug,
            ingestUrl: ingestUrl(options.ingestUrl, env, warnings),
        },
        debug,
        warnings,
    };
}

function release(options: ValidOptions, value: string | null): Release | null {
    if (value === null) {
        return null;
    }

    return {
        value,
        source:
            options.release === undefined
                ? `env:${ENVIRONMENT_VARIABLES.release}`
                : 'init',
    };
}

function isStringOption(name: string): name is StringOption {
    return Object.hasOwn(ENVIRONMENT_VARIABLES, name);
}

/** Deploy tools often set variables to an empty string, which means unset. */
function fromEnvironment(env: Environment, name: string): string | null {
    const value = env[name]?.trim();

    return value === undefined || value === '' ? null : value;
}

function isOn(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();

    return normalized === '1' || normalized === 'true';
}

function ingestOrigin(value: string): string | null {
    try {
        const url = new URL(value);

        return url.protocol === 'https:' || url.protocol === 'http:'
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

/** An option was validated already; the environment variable is checked here. */
function ingestUrl(
    option: string | undefined,
    env: Environment,
    warnings: string[],
): string {
    if (option !== undefined) {
        return option;
    }

    const fromVariable = fromEnvironment(env, ENVIRONMENT_VARIABLES.ingestUrl);
    if (fromVariable === null) {
        return DEFAULT_INGEST_URL;
    }

    const url = ingestOrigin(fromVariable);
    if (url === null) {
        warnings.push(
            `${ENVIRONMENT_VARIABLES.ingestUrl} is not an http(s) URL; using the default`,
        );
        return DEFAULT_INGEST_URL;
    }

    return url;
}
