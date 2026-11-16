/**
 * Release detection from CI and hosting commit variables. `init({ release })`
 * and `STACKRADAR_RELEASE` come first and are configuration; reading `.git`
 * comes last and lives with the file system code.
 */

import { MAX_NAME_LENGTH, type Environment } from './configuration.js';

export interface Release {
    value: string;
    /** Where it was found: `init`, `env:<NAME>` or `git`. */
    source: string;
}

/** Platform-specific names first, generic ones last, so a stray generic variable never wins. */
const COMMIT_VARIABLES = [
    'GITHUB_SHA',
    'CI_COMMIT_SHA',
    'BITBUCKET_COMMIT',
    'CIRCLE_SHA1',
    'CODEBUILD_RESOLVED_SOURCE_VERSION',
    'BUILD_SOURCEVERSION',
    'VERCEL_GIT_COMMIT_SHA',
    'RENDER_GIT_COMMIT',
    'RAILWAY_GIT_COMMIT_SHA',
    'HEROKU_BUILD_COMMIT',
    'HEROKU_SLUG_COMMIT',
    'SOURCE_VERSION',
    'SOURCE_COMMIT',
    'GIT_COMMIT',
];

/**
 * The first commit variable with a usable value. A value that is empty,
 * equal to its own name (an unfilled platform placeholder) or longer than
 * the server accepts is skipped.
 */
export function releaseFromCommitVariables(env: Environment): Release | null {
    for (const name of COMMIT_VARIABLES) {
        const value = env[name]?.trim();

        if (
            value !== undefined &&
            value !== '' &&
            value !== name &&
            value.length <= MAX_NAME_LENGTH
        ) {
            return { value, source: `env:${name}` };
        }
    }

    return null;
}
