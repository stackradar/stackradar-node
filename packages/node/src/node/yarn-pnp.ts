/**
 * The `yarn-pnp` detector: the app's production dependency
 * tree under Yarn Plug'n'Play, which has no node_modules. Packages are
 * resolved through Yarn's `pnpapi`. The rules match the dependency-tree
 * walk, except that a package's peers are whatever Yarn resolved for it:
 * Yarn's map says what the package loads at runtime.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { Package } from '../core/inventory.js';
import type { PackageError } from '../core/report.js';
import {
    DEFAULT_LIMITS,
    MAX_ERRORS,
    parseManifest,
    usablePackage,
    type Manifest,
    type TreeResult,
    type WalkLimits,
} from './dependency-tree.js';

/** The part of Yarn's `pnpapi` the walk uses. */
export interface PnpApi {
    findPackageLocator(location: string): PackageLocator | null;
    getPackageInformation(locator: PackageLocator): PackageInformation | null;
    /** Maps a `__virtual__` location to the real one; Yarn 2 and later. */
    resolveVirtual?(location: string): string | null;
}

export interface PackageLocator {
    name: string | null;
    reference: string | null;
}

interface PackageInformation {
    packageLocation: string;
    /** A reference, an `[aliased name, reference]` pair for an `npm:` alias, or `null` when unmet. */
    packageDependencies: Map<string, string | [string, string] | null>;
}

interface Task {
    locator: { name: string; reference: string };
    /** The name the asking package used, which an alias changes. */
    requestedName: string;
    /** Read from the asking package only when it is needed; see `visit`. */
    optional: boolean | undefined;
    declaredByApp: boolean;
    parentLocation: string;
}

/**
 * The app's tree, or `null` when Yarn does not know the app root, so
 * another detector should run.
 */
export async function walkPnp(
    appRoot: string,
    pnp: PnpApi,
    limits: WalkLimits = DEFAULT_LIMITS,
    now: () => number = Date.now,
): Promise<TreeResult | null> {
    const deadline = now() + limits.milliseconds;
    const appLocator = pnp.findPackageLocator(appRoot + sep);
    const appInformation =
        appLocator === null ? null : pnp.getPackageInformation(appLocator);
    const appManifest = await readManifest(appRoot);
    if (appInformation === null || appManifest === null) {
        return null;
    }

    const errors: PackageError[] = [];
    const listed = new Map<string, Package>();
    /**
     * Per package, whether it is installed. Every task asking for a package
     * that is not installed is checked: one that only an optional
     * dependency asked for first may still be required by another.
     */
    const installed = new Map<string, Promise<boolean>>();
    /** Per asking package, read once: its package.json may sit in a large zip. */
    const optionalNames = new Map<string, Promise<Set<string>>>();
    const optionalIn = (location: string): Promise<Set<string>> => {
        let names = optionalNames.get(location);
        if (names === undefined) {
            names = readManifest(location).then((manifest) =>
                namesOf(manifest?.optionalDependencies),
            );
            optionalNames.set(location, names);
        }
        return names;
    };
    let declaredMissing = false;
    /** A dependency of an installed package is missing, or a package is unusable. */
    let incomplete = false;

    const failed = (code: string): TreeResult => ({
        status: 'failed',
        packages: [],
        declaredMissing,
        errors: [{ code }, ...errors].slice(0, MAX_ERRORS),
    });
    const missing = (task: Task): void => {
        if (task.optional) {
            return;
        }
        if (task.declaredByApp) {
            declaredMissing = true;
        } else {
            incomplete = true;
            if (errors.length < MAX_ERRORS) {
                errors.push({ code: 'unresolved' });
            }
        }
    };

    const notInstalled = async (task: Task): Promise<Task[]> => {
        task.optional ??= (await optionalIn(task.parentLocation)).has(
            task.requestedName,
        );
        missing(task);
        return [];
    };

    async function visit(task: Task): Promise<Task[]> {
        const key = `${task.locator.name}@${task.locator.reference}`;
        const seen = installed.get(key);
        if (seen !== undefined) {
            return (await seen) ? [] : notInstalled(task);
        }

        const information = pnp.getPackageInformation(task.locator);
        const check =
            information === null
                ? Promise.resolve(false)
                : isInstalled(
                      pnp.resolveVirtual?.(information.packageLocation) ??
                          information.packageLocation,
                  );
        installed.set(key, check);
        if (information === null || !(await check)) {
            return notInstalled(task);
        }

        const version = registryVersion(task.locator.reference);
        if (version !== null) {
            const listedPackage = usablePackage({
                name: task.locator.name,
                version,
            });
            if (listedPackage === null) {
                incomplete = true;
                if (errors.length < MAX_ERRORS) {
                    errors.push({ code: 'invalid_package' });
                }
            } else {
                listed.set(`${listedPackage.name}\t${version}`, listedPackage);
            }
        }

        // Workspace and local packages are not listed, but followed. A
        // workspace's package.json is on disk; a registry package's is in a
        // zip archive, which Yarn loads whole to read one file, so it is
        // read only when a dependency turns out not to be installed.
        const workspace = isWorkspace(task.locator.reference);
        const manifest = workspace
            ? await readManifest(information.packageLocation)
            : null;
        if (workspace && manifest === null) {
            // Without it, which dependencies to follow is unknown.
            incomplete = true;
            if (errors.length < MAX_ERRORS) {
                errors.push({ code: 'invalid_package' });
            }
            return [];
        }

        return followed(information, manifest, task.locator, false);
    }

    let frontier = followed(appInformation, appManifest, null, true);

    while (frontier.length > 0) {
        const next: Task[] = [];

        for (
            let start = 0;
            start < frontier.length;
            start += limits.concurrency
        ) {
            if (now() > deadline) {
                return failed('timeout');
            }

            const batch = frontier.slice(start, start + limits.concurrency);
            for (const children of await Promise.all(batch.map(visit))) {
                next.push(...children);
            }

            if (listed.size > limits.maxPackages) {
                return failed('too_many_packages');
            }
        }

        frontier = next;
    }

    return {
        status: declaredMissing || incomplete ? 'partial' : 'collected',
        packages: [...listed.values()],
        declaredMissing,
        errors,
    };

    /**
     * For the app, its `dependencies` and `optionalDependencies`, and for
     * another workspace also its peers: Yarn's map for a workspace also
     * holds dev dependencies. Their optional peers are left out unless also
     * declared as dependencies. For a package, everything Yarn resolved for
     * it, peers included: the package loads what Yarn mapped it to, also
     * when a dev dependency provides it. An unmet peer is skipped.
     */
    function followed(
        information: PackageInformation,
        manifest: Manifest | null,
        self: Task['locator'] | null,
        isApp: boolean,
    ): Task[] {
        const optional = namesOf(manifest?.optionalDependencies);
        const optionalPeers = new Set(
            Object.entries(
                (manifest?.peerDependenciesMeta ?? {}) as Record<
                    string,
                    { optional?: unknown }
                >,
            )
                .filter(([, meta]) => meta?.optional === true)
                .map(([name]) => name),
        );
        const declared = new Set([
            ...namesOf(manifest?.dependencies),
            ...optional,
        ]);
        const workspace = self === null || isWorkspace(self.reference);
        const wanted = isApp
            ? declared
            : workspace
              ? new Set([...declared, ...namesOf(manifest?.peerDependencies)])
              : information.packageDependencies.keys();
        const tasks: Task[] = [];

        for (const name of wanted) {
            if (optionalPeers.has(name) && !declared.has(name)) {
                continue;
            }

            const target = information.packageDependencies.get(name);
            const task = {
                requestedName: name,
                optional: workspace ? optional.has(name) : undefined,
                declaredByApp: isApp,
                parentLocation: information.packageLocation,
            };

            if (target === null || target === undefined) {
                // Unmet: Yarn did not install it. A missing peer is fine.
                if (isApp) {
                    missing({ locator: { name, reference: '' }, ...task });
                }
                continue;
            }

            const locator = Array.isArray(target)
                ? { name: target[0], reference: target[1] }
                : { name, reference: target };
            if (
                self !== null &&
                locator.name === self.name &&
                locator.reference === self.reference
            ) {
                continue;
            }

            tasks.push({ locator, ...task });
        }

        return tasks;
    }
}

/**
 * The version of a registry package from its Yarn reference:
 * `npm:1.2.3`, a virtual `virtual:<hash>#npm:1.2.3`, or a patched
 * `patch:name@npm%3A1.2.3#…`, without bindings such as
 * `::__archiveUrl=…`. Anything else (workspace, file, link, portal, git)
 * is not a registry package.
 */
export function registryVersion(reference: string): string | null {
    let resolved = withoutVirtual(reference);

    if (resolved.startsWith('patch:')) {
        const source = /^patch:(?:@[^@/]+\/)?[^@]+@([^#]+)#/.exec(resolved);
        if (source?.[1] === undefined) {
            return null;
        }
        try {
            resolved = decodeURIComponent(source[1]);
        } catch {
            return null;
        }
    }

    const bindings = resolved.indexOf('::');
    if (bindings !== -1) {
        resolved = resolved.slice(0, bindings);
    }

    return resolved.startsWith('npm:') && resolved.length > 'npm:'.length
        ? resolved.slice('npm:'.length)
        : null;
}

/** A workspace, also as a virtual instance of one. */
function isWorkspace(reference: string): boolean {
    return withoutVirtual(reference).startsWith('workspace:');
}

/** `virtual:<hash>#<reference>` to `<reference>`. */
function withoutVirtual(reference: string): string {
    return reference.startsWith('virtual:')
        ? reference.slice(reference.indexOf('#') + 1)
        : reference;
}

/**
 * Whether Yarn installed the package. Inside a zip in `.yarn/cache` the
 * zip is checked, which works with and without Yarn's zip-aware `fs`.
 */
async function isInstalled(location: string): Promise<boolean> {
    const zip = location.indexOf('.zip' + sep);
    const path = zip === -1 ? location : location.slice(0, zip + '.zip'.length);

    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function readManifest(directory: string): Promise<Manifest | null> {
    try {
        return parseManifest(
            await readFile(join(directory, 'package.json'), 'utf8'),
        );
    } catch {
        return null;
    }
}

function namesOf(field: unknown): Set<string> {
    return new Set(
        typeof field === 'object' && field !== null ? Object.keys(field) : [],
    );
}
