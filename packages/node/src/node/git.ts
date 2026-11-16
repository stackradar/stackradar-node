/**
 * Release detection from `.git`, read without the `git` binary.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Release } from '../core/release.js';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Characters `git check-ref-format` never allows: controls, space, ~ ^ : ? * [ \ */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_REF = /[\u0000- \u007f~^:?*[\\]/;

/**
 * The commit checked out in the nearest `.git` directory at or above the
 * app root, which in a monorepo sits above the app. `HEAD` is followed to
 * its branch's ref file, then to `packed-refs`. A `.git` file, as in
 * worktrees and submodules, is not followed. Anything but a full commit
 * hash gives `null`.
 */
export async function releaseFromGit(appRoot: string): Promise<Release | null> {
    const gitDirectory = await findGitDirectory(appRoot);
    if (gitDirectory === null) {
        return null;
    }

    const head = await readText(join(gitDirectory, 'HEAD'));
    if (head === null) {
        return null;
    }

    const commit = head.startsWith('ref:')
        ? await resolveRef(gitDirectory, head.slice('ref:'.length).trim())
        : head;

    return commit !== null && COMMIT.test(commit)
        ? { value: commit, source: 'git' }
        : null;
}

async function findGitDirectory(start: string): Promise<string | null> {
    for (let directory = start; ; directory = dirname(directory)) {
        const candidate = join(directory, '.git');
        const found = await stat(candidate).catch(() => null);
        if (found !== null) {
            return found.isDirectory() ? candidate : null;
        }

        if (dirname(directory) === directory) {
            return null;
        }
    }
}

async function resolveRef(
    gitDirectory: string,
    ref: string,
): Promise<string | null> {
    if (!isRefName(ref)) {
        return null;
    }

    const loose = await readText(join(gitDirectory, ref));
    if (loose !== null) {
        return loose;
    }

    const packed = await readText(join(gitDirectory, 'packed-refs'));
    for (const line of packed?.split('\n') ?? []) {
        const [commit, name] = line.trim().split(' ');
        if (name === ref && commit !== undefined) {
            return commit;
        }
    }

    return null;
}

/**
 * A ref name under `refs/` that `git check-ref-format` accepts, punctuation
 * and Unicode included. The same rules keep the read inside `.git`: no
 * `..`, no component starting with `.`, no backslash and no colon.
 */
function isRefName(ref: string): boolean {
    const components = ref.split('/');

    return (
        ref.startsWith('refs/') &&
        !FORBIDDEN_IN_REF.test(ref) &&
        !ref.includes('..') &&
        !ref.includes('@{') &&
        !ref.endsWith('.') &&
        components.every(
            (component) =>
                component !== '' &&
                !component.startsWith('.') &&
                !component.endsWith('.lock'),
        )
    );
}

async function readText(path: string): Promise<string | null> {
    try {
        return (await readFile(path, 'utf8')).trim();
    } catch {
        return null;
    }
}
