/**
 * The package list: the first detector that applies, its
 * status and the `packages` section of the Runtime Report. Never throws.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { Environment } from '../core/configuration.js';
import {
    canonicalPackages,
    inventoryHash,
    type Package,
} from '../core/inventory.js';
import type { PackageError, PackagesSection } from '../core/report.js';
import { BUILD_INVENTORY_FILE, readBuildInventory } from './build-inventory.js';
import {
    MAX_ERRORS,
    walkDependencyTree,
    type TreeResult,
    type WalkLimits,
} from './dependency-tree.js';
import { walkPnp, type PnpApi } from './yarn-pnp.js';

export interface PackageCollection {
    section: PackagesSection;
    /** The list behind `inventory_hash`, uploaded when the server asks for it. */
    packages: Package[] | null;
}

export interface CollectionOptions {
    limits?: WalkLimits;
    /** Yarn's `pnpapi`; by default loaded when the process runs under Plug'n'Play. */
    pnp?: PnpApi | null;
}

/** Set by the `server.js` of a Next.js standalone build. */
const NEXT_STANDALONE_MARKER = '__NEXT_PRIVATE_STANDALONE_CONFIG';

/**
 * Detectors in order: `build-inventory`, `yarn-pnp`, `dependency-tree`,
 * `none`. An unusable Build Inventory is recorded as an error and the next
 * detector runs.
 */
export async function collectPackages(
    appRoot: string | null,
    env: Environment,
    options: CollectionOptions = {},
): Promise<PackageCollection> {
    let detector = 'none';

    try {
        if (appRoot === null || !(await hasManifest(appRoot))) {
            return nothing(detector, 'not_found');
        }

        detector = 'build-inventory';
        const inventory = await readBuildInventory(appRoot);
        if (inventory.status === 'read') {
            return listed(detector, 'collected', inventory.packages, []);
        }
        const inventoryErrors: PackageError[] =
            inventory.status === 'invalid'
                ? [
                      {
                          code: 'invalid_build_inventory',
                          path: BUILD_INVENTORY_FILE,
                      },
                  ]
                : [];

        const pnp =
            options.pnp === undefined ? loadPnpApi(appRoot) : options.pnp;
        let tree: TreeResult | null = null;
        if (pnp !== null) {
            detector = 'yarn-pnp';
            tree = await walkPnp(appRoot, pnp, options.limits);
        }
        if (tree === null) {
            detector = 'dependency-tree';
            tree = await walkDependencyTree(appRoot, options.limits);
        }

        if (tree.status === 'failed') {
            return nothing(detector, 'failed', [
                ...inventoryErrors,
                ...tree.errors,
            ]);
        }

        // A bundled app: its server dependencies are compiled into chunks
        // where no runtime reader can name them.
        const bundled =
            tree.declaredMissing || env[NEXT_STANDALONE_MARKER] !== undefined;
        const errors: PackageError[] = [
            ...(bundled ? [{ code: 'bundled_app' }] : []),
            ...inventoryErrors,
            ...tree.errors,
        ].slice(0, MAX_ERRORS);
        const status = bundled ? 'partial' : tree.status;

        if (tree.packages.length === 0 && status === 'partial') {
            return nothing(detector, 'not_found', errors);
        }

        return listed(detector, status, tree.packages, errors);
    } catch (error) {
        return nothing(detector, 'failed', [
            { code: (error as NodeJS.ErrnoException).code ?? 'internal_error' },
        ]);
    }
}

function listed(
    detector: string,
    status: 'collected' | 'partial',
    found: Package[],
    errors: PackageError[],
): PackageCollection {
    const packages = canonicalPackages(found);

    return {
        section: {
            detector,
            status,
            ecosystem: 'npm',
            inventory_hash: inventoryHash('npm', packages),
            ...(errors.length > 0 ? { errors } : {}),
        },
        packages,
    };
}

/** Yarn registers `pnpapi` for every process it starts under Plug'n'Play. */
export function loadPnpApi(appRoot: string): PnpApi | null {
    if (process.versions.pnp === undefined) {
        return null;
    }

    try {
        return createRequire(join(appRoot, 'package.json'))('pnpapi') as PnpApi;
    } catch {
        return null;
    }
}

function nothing(
    detector: string,
    status: 'not_found' | 'failed',
    errors: PackageError[] = [],
): PackageCollection {
    // An unusable Build Inventory adds one to a failed walk's own errors; the
    // server refuses the whole report above its limit.
    const capped = errors.slice(0, MAX_ERRORS);
    return {
        section: {
            detector,
            status,
            ecosystem: null,
            inventory_hash: null,
            ...(capped.length > 0 ? { errors: capped } : {}),
        },
        packages: null,
    };
}

async function hasManifest(directory: string): Promise<boolean> {
    try {
        await readFile(join(directory, 'package.json'));
        return true;
    } catch {
        return false;
    }
}
