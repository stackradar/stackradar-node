/**
 * The `build-inventory` detector: the package list recorded
 * when the app was built, for bundled apps whose installed packages the
 * runtime cannot see. Read as JSON, never executed.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Package } from '../core/inventory.js';
import { DEFAULT_LIMITS, usablePackage } from './dependency-tree.js';

export const BUILD_INVENTORY_FILE = '.stackradar/build-inventory.json';

const MAX_BYTES = 1024 * 1024;

export type BuildInventoryRead =
    | { status: 'absent' }
    | { status: 'invalid' }
    | { status: 'read'; packages: Package[] };

/**
 * The Build Inventory at the app root. A file that is too large, not the
 * documented format, or holds any entry the server would refuse is
 * `invalid` as a whole: the reporter wrote it, so a bad entry means a bad
 * file.
 */
export async function readBuildInventory(
    appRoot: string,
): Promise<BuildInventoryRead> {
    const path = join(appRoot, BUILD_INVENTORY_FILE);

    try {
        if ((await stat(path)).size > MAX_BYTES) {
            return { status: 'invalid' };
        }

        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        const packages = inventoryPackages(parsed);

        return packages === null
            ? { status: 'invalid' }
            : { status: 'read', packages };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        return code === 'ENOENT' || code === 'ENOTDIR'
            ? { status: 'absent' }
            : { status: 'invalid' };
    }
}

/** `{ "format": 1, "ecosystem": "npm", "generator": {…}, "packages": [{ "name", "version" }] }` */
function inventoryPackages(parsed: unknown): Package[] | null {
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }

    const { format, ecosystem, packages } = parsed as Record<string, unknown>;
    if (
        format !== 1 ||
        ecosystem !== 'npm' ||
        !Array.isArray(packages) ||
        packages.length > DEFAULT_LIMITS.maxPackages
    ) {
        return null;
    }

    const usable = packages.map(usablePackage);

    return usable.every((entry) => entry !== null) ? usable : null;
}
