/**
 * Finds the app root: the directory of the running app's `package.json`
 *. Reads the file system, so it runs after start-up.
 */

import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { MAX_NAME_LENGTH } from '../core/configuration.js';
import { parseManifest, type Manifest } from './dependency-tree.js';

export interface AppRoot {
    path: string;
    /** `configured`: `init({ root })` or `STACKRADAR_ROOT`. */
    source: 'configured' | 'entry' | 'working-directory';
}

export interface AppRootInputs {
    /** `init({ root })` or `STACKRADAR_ROOT`, resolved against `cwd`. */
    configured: string | null;
    /** The entry script, `process.argv[1]`; absent for `node -e` and the REPL. */
    entry: string | undefined;
    cwd: string;
}

export async function resolveAppRoot({
    configured,
    entry,
    cwd,
}: AppRootInputs): Promise<AppRoot | null> {
    if (configured !== null) {
        return { path: resolve(cwd, configured), source: 'configured' };
    }

    const entryPath =
        entry === undefined
            ? null
            : await realpath(resolve(cwd, entry)).catch(() => null);

    // A launcher inside node_modules, such as `next start`, says nothing
    // about the app; the working directory does.
    if (entryPath !== null && !isInsideNodeModules(entryPath)) {
        const path = await findAppPackage(dirname(entryPath));

        return path === null ? null : { path, source: 'entry' };
    }

    const path = await findAppPackage(cwd);

    return path === null ? null : { path, source: 'working-directory' };
}

/**
 * The nearest directory, from `start` upwards and outside node_modules,
 * whose `package.json` has a `name` or `dependencies`. A `package.json` that
 * only sets `"type": "module"`, as builds often write into `dist/`, does not
 * count.
 */
async function findAppPackage(start: string): Promise<string | null> {
    for (let directory = start; ; directory = dirname(directory)) {
        if (!isInsideNodeModules(directory)) {
            const manifest = await readManifest(
                join(directory, 'package.json'),
            );
            if (manifest !== null && describesAnApp(manifest)) {
                return directory;
            }
        }

        if (dirname(directory) === directory) {
            return null;
        }
    }
}

/** The default Service: the `name` in the app root's `package.json`. */
export async function appName(appRoot: string): Promise<string | null> {
    const manifest = await readManifest(join(appRoot, 'package.json'));
    const name = typeof manifest?.name === 'string' ? manifest.name.trim() : '';

    return name === '' || name.length > MAX_NAME_LENGTH ? null : name;
}

function isInsideNodeModules(path: string): boolean {
    return path.split(sep).includes('node_modules');
}

async function readManifest(path: string): Promise<Manifest | null> {
    try {
        return parseManifest(await readFile(path, 'utf8'));
    } catch {
        return null;
    }
}

function describesAnApp(manifest: Record<string, unknown>): boolean {
    const { name, dependencies } = manifest;

    return (
        (typeof name === 'string' && name !== '') ||
        (typeof dependencies === 'object' && dependencies !== null)
    );
}
