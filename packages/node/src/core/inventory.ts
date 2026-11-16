/**
 * The package list and its inventory hash. The server
 * computes the same hash from an uploaded list, so the two must match byte
 * for byte.
 */

import { createHash } from 'node:crypto';

export interface Package {
    name: string;
    version: string;
}

const PREFIX = 'stackradar-inventory-v1\n';

/**
 * One entry per distinct name and version, sorted by the UTF-8 bytes of
 * `name + "\t" + version`. JavaScript's default sort compares UTF-16 code
 * units, which orders some names differently.
 */
export function canonicalPackages(packages: Iterable<Package>): Package[] {
    const byLine = new Map<string, Package>();
    for (const { name, version } of packages) {
        byLine.set(`${name}\t${version}`, { name, version });
    }

    return [...byLine.entries()]
        .map(([line, pkg]) => ({ bytes: Buffer.from(line, 'utf8'), pkg }))
        .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
        .map(({ pkg }) => pkg);
}

export function inventoryHash(
    ecosystem: string,
    packages: Iterable<Package>,
): string {
    const lines = canonicalPackages(packages)
        .map(({ name, version }) => `${name}\t${version}\n`)
        .join('');

    return createHash('sha256')
        .update(`${PREFIX}${ecosystem}\n${lines}`, 'utf8')
        .digest('hex');
}
