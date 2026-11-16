/**
 * Writes the Build Inventory (plan, "Build Inventory file"): the app's
 * production dependency tree, walked on the build machine's install, for
 * bundled apps whose packages the runtime cannot see. Used by
 * `withStackRadar()` and the `stackradar-node build-inventory` command.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { canonicalPackages } from '../core/inventory.js';
import { MAX_BODY_BYTES } from '../core/lifecycle.js';
import { REPORTER_NAME } from '../core/report.js';
import { REPORTER_VERSION } from '../core/version.js';
import { BUILD_INVENTORY_FILE } from './build-inventory.js';
import { walkDependencyTree } from './dependency-tree.js';
import { loadPnpApi } from './packages.js';
import { walkPnp, type PnpApi } from './yarn-pnp.js';

export interface WriteOptions {
    /** The app whose installed production tree is listed. */
    appRoot: string;
    /** The app root of what ships; the app root by default. */
    outDir?: string;
    /** Yarn's `pnpapi`; by default loaded under Plug'n'Play. */
    pnp?: PnpApi | null;
}

export interface WriteResult {
    written: boolean;
    path: string;
    packages?: number;
    /** Something the person running the build should know. */
    warning?: string;
}

/**
 * Writes `.stackradar/build-inventory.json` into the output directory,
 * atomically and byte-identical for identical installs. When the walk does
 * not give a complete list, or writing fails, nothing is written and an
 * earlier file is removed, so a build never ships a stale list. Never
 * throws: problems come back as a warning.
 */
export async function writeBuildInventory({
    appRoot,
    outDir = appRoot,
    pnp,
}: WriteOptions): Promise<WriteResult> {
    const out = resolve(outDir);
    const path = join(out, BUILD_INVENTORY_FILE);

    if (isServed(out)) {
        return {
            written: false,
            path,
            warning: `${outDir} is served to browsers, so no Build Inventory is written there`,
        };
    }

    const temporary = `${path}.${process.pid}.tmp`;

    try {
        const api = pnp === undefined ? loadPnpApi(appRoot) : pnp;
        const tree =
            (api === null ? null : await walkPnp(appRoot, api)) ??
            (await walkDependencyTree(appRoot));

        if (tree.status !== 'collected') {
            await rm(path, { force: true });
            return {
                written: false,
                path,
                warning:
                    tree.status === 'failed'
                        ? `the dependency walk stopped (${tree.errors[0]?.code ?? 'unknown'}); no Build Inventory written`
                        : 'some production dependencies are not installed on this machine; no Build Inventory written',
            };
        }

        const packages = canonicalPackages(tree.packages);
        const content = `${JSON.stringify(
            {
                format: 1,
                ecosystem: 'npm',
                generator: { name: REPORTER_NAME, version: REPORTER_VERSION },
                packages,
            },
            null,
            2,
        )}\n`;
        if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
            await rm(path, { force: true });
            return {
                written: false,
                path,
                warning: 'the Build Inventory would be over 1 MB; not written',
            };
        }

        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, content);
        await rename(temporary, path);

        const shipsManifest = await stat(join(out, 'package.json')).then(
            () => true,
            () => false,
        );

        return {
            written: true,
            path,
            packages: packages.length,
            ...(shipsManifest
                ? {}
                : {
                      warning: `${outDir} has no package.json; the reporter looks for the Build Inventory beside the package.json of what ships`,
                  }),
        };
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        const reason = `could not write the Build Inventory (${error instanceof Error ? error.message : String(error)})`;

        return {
            written: false,
            path,
            warning: await rm(path, { force: true }).then(
                () => reason,
                () =>
                    `${reason}, nor remove the earlier ${path}: delete it, or the build ships a stale package list`,
            ),
        };
    }
}

/** Directories a web server serves: anything under `public/`, and `.next/static`. */
function isServed(directory: string): boolean {
    const segments = directory.split(sep);

    return (
        segments.includes('public') ||
        directory.includes(`${sep}.next${sep}static`)
    );
}
