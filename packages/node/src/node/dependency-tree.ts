/**
 * The `dependency-tree` detector: the app's production
 * dependency tree, starting from its own `dependencies` and
 * `optionalDependencies` and resolving every name the way Node.js does,
 * from the requiring package's real path up through `node_modules`.
 */

import { readFile, realpath } from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
    type PlatformPath,
} from 'node:path';

import type { Package } from '../core/inventory.js';
import type { PackageError } from '../core/report.js';

export interface TreeResult {
    /**
     * `collected`: the whole tree resolved. `partial`: a dependency that
     * should be installed did not resolve, or an installed package's
     * `package.json` could not be read or used, so the list says only what
     * is present. `failed`: a limit was reached, and no list is sent.
     */
    status: 'collected' | 'partial' | 'failed';
    packages: Package[];
    /** Whether a dependency the app itself declares did not resolve. */
    declaredMissing: boolean;
    errors: PackageError[];
}

export interface WalkLimits {
    maxPackages: number;
    milliseconds: number;
    concurrency: number;
}

export const DEFAULT_LIMITS: WalkLimits = {
    maxPackages: 10_000,
    milliseconds: 5_000,
    concurrency: 8,
};

/** What the server accepts in `packages.errors` and in a package's fields. */
export const MAX_ERRORS = 50;
const MAX_FIELD_LENGTH = 255;

/** Asked for as a local or workspace package: skipped, its dependencies followed. */
const LOCAL_SPEC = /^(?:workspace|file|link|portal):/;
/**
 * Git specs the package managers accept: `git+…:`, `git:` and `ssh:` URLs,
 * host shortcuts, `owner/repo`, and the scp form `user@host.tld:path`.
 */
const GIT_SPEC =
    /^(?:git\+|git:|ssh:|github:|gitlab:|bitbucket:|gist:)|^[^@:/\s#]+\/[^:/\s#]+(?:#.*)?$|^[^@:/\s]+@[^:/\s]+\.[^:/\s]+:/;
/** `name@` or `npm:name@` in front of an aliased spec. */
const ALIAS_PREFIX = /^(?:npm:)?(?:@[^/@\s:]+\/)?[^/@\s:]+@/;

/** npm's package name rules, which also keep resolution inside node_modules. */
const PACKAGE_NAME =
    /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** Unicode's control characters (C0, DEL and C1), which the server refuses. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

interface Dependency {
    name: string;
    spec: string;
    optional: boolean;
    peer: boolean;
}

interface Task {
    /** The real directory of the package that declares the dependency. */
    from: string;
    dependency: Dependency;
    declaredByApp: boolean;
}

export type Manifest = Record<string, unknown>;

type Resolution =
    | { directory: string; manifestPath: string; text: string }
    | { manifestPath: string; error: NodeJS.ErrnoException }
    | null;

/**
 * `file`'s path from the app root, with `/` separators. On Windows a file on
 * another drive or network share has none: `relative()` returns its
 * absolute path, which is never sent.
 */
export function pathFromRoot(
    root: string,
    file: string,
    paths: Pick<PlatformPath, 'isAbsolute' | 'relative' | 'sep'> = {
        isAbsolute,
        relative,
        sep,
    },
): string | undefined {
    const fromRoot = paths.relative(root, file);
    return paths.isAbsolute(fromRoot)
        ? undefined
        : fromRoot.split(paths.sep).join('/');
}

export async function walkDependencyTree(
    appRoot: string,
    limits: WalkLimits = DEFAULT_LIMITS,
    now: () => number = Date.now,
): Promise<TreeResult> {
    const deadline = now() + limits.milliseconds;
    const root = await realpath(appRoot);
    const errors: PackageError[] = [];
    const listed = new Map<string, Package>();
    const visited = new Set<string>([root]);
    let declaredMissing = false;
    /** A dependency of an installed package is missing, or a package file is unusable. */
    let incomplete = false;

    /** An error naming `file` by its path from the app root, if it has one. */
    const located = (code: string, file: string): PackageError => {
        const fromRoot = pathFromRoot(root, file);
        return fromRoot === undefined ? { code } : { code, path: fromRoot };
    };
    const addError = (error: PackageError): void => {
        if (errors.length < MAX_ERRORS) {
            errors.push(error);
        }
    };
    const failed = (code: string): TreeResult => ({
        status: 'failed',
        packages: [],
        declaredMissing,
        errors: [{ code }, ...errors].slice(0, MAX_ERRORS),
    });

    const rootManifest = parseManifest(
        await readFile(join(root, 'package.json'), 'utf8'),
    );
    if (rootManifest === null) {
        return failed('invalid_package');
    }

    async function visit({
        from,
        dependency,
        declaredByApp,
    }: Task): Promise<Task[]> {
        const found = await resolvePackage(dependency.name, from);

        if (found === null) {
            // Not installed. Optional dependencies and peers may be absent.
            if (!dependency.optional && !dependency.peer) {
                if (declaredByApp) {
                    declaredMissing = true;
                } else {
                    incomplete = true;
                    addError(located('unresolved', join(from, 'package.json')));
                }
            }
            return [];
        }

        // Installed but unusable: the list can no longer be complete.
        if ('error' in found) {
            incomplete = true;
            addError(located(found.error.code ?? 'EIO', found.manifestPath));
            return [];
        }

        if (visited.has(found.directory)) {
            return [];
        }
        visited.add(found.directory);

        const manifest = parseManifest(found.text);
        if (manifest === null) {
            incomplete = true;
            addError(located('invalid_package', found.manifestPath));
            return [];
        }

        const isLocal =
            isLocalSpec(dependency.spec) ||
            !isInsideNodeModules(found.directory);

        if (!isLocal) {
            const listedPackage = usablePackage(manifest);
            if (listedPackage === null) {
                incomplete = true;
                addError(located('invalid_package', found.manifestPath));
            } else {
                listed.set(
                    `${listedPackage.name}\t${listedPackage.version}`,
                    listedPackage,
                );
            }
        }

        return dependenciesOf(manifest, false).map((child) => ({
            from: found.directory,
            dependency: child,
            declaredByApp: false,
        }));
    }

    let frontier: Task[] = dependenciesOf(rootManifest, true).map(
        (dependency) => ({ from: root, dependency, declaredByApp: true }),
    );

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
}

/**
 * The app's own `dependencies` and `optionalDependencies`; for an installed
 * package also its required `peerDependencies`. Optional peers
 * (`peerDependenciesMeta`) are not followed.
 */
function dependenciesOf(manifest: Manifest, isApp: boolean): Dependency[] {
    const byName = new Map<string, Dependency>();
    const add = (field: unknown, optional: boolean, peer: boolean): void => {
        if (typeof field !== 'object' || field === null) {
            return;
        }
        for (const [name, spec] of Object.entries(field)) {
            if (typeof spec === 'string' && PACKAGE_NAME.test(name)) {
                byName.set(name, { name, spec, optional, peer });
            }
        }
    };

    if (!isApp) {
        const meta = manifest.peerDependenciesMeta as
            Record<string, { optional?: unknown }> | undefined;
        const peers = Object.fromEntries(
            Object.entries(
                (manifest.peerDependencies ?? {}) as Record<string, unknown>,
            ).filter(([name]) => meta?.[name]?.optional !== true),
        );
        add(peers, false, true);
    }
    add(manifest.dependencies, false, false);
    // An optional dependency is optional even when also listed in dependencies.
    add(manifest.optionalDependencies, true, false);

    return [...byName.values()];
}

/** Node.js's lookup: `<dir>/node_modules/<name>` for each ancestor that is not itself a node_modules. */
async function resolvePackage(name: string, from: string): Promise<Resolution> {
    for (let directory = from; ; directory = dirname(directory)) {
        if (basename(directory) !== 'node_modules') {
            const candidate = join(directory, 'node_modules', name);
            const manifestPath = join(candidate, 'package.json');

            try {
                const text = await readFile(manifestPath, 'utf8');
                return {
                    directory: await realpath(candidate),
                    manifestPath,
                    text,
                };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                    return {
                        manifestPath,
                        error: error as NodeJS.ErrnoException,
                    };
                }
            }
        }

        if (dirname(directory) === directory) {
            return null;
        }
    }
}

/**
 * A `package.json` object, or `null`. A leading byte order mark is
 * dropped, as Node.js and npm do. Shared with the other manifest readers.
 */
export function parseManifest(text: string): Manifest | null {
    try {
        const parsed: unknown = JSON.parse(
            text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
        );

        return typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Manifest)
            : null;
    } catch {
        return null;
    }
}

/**
 * The name and version exactly as declared, if the server will accept
 * them: non-empty strings of at most 255 characters without control
 * characters. Shared with the Build Inventory reader.
 */
export function usablePackage(value: unknown): Package | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const { name, version } = value as Record<string, unknown>;
    const usable = (field: unknown): field is string =>
        typeof field === 'string' &&
        field !== '' &&
        field.length <= MAX_FIELD_LENGTH &&
        !CONTROL_CHARACTERS.test(field);

    return usable(name) && usable(version) ? { name, version } : null;
}

/**
 * Asked for as a workspace, local or git package. pnpm deploy writes the
 * aliased form `<name>@file:…`, so a leading `<name>@` is looked past; the
 * scp form `git@host:path` is tested before that.
 */
function isLocalSpec(spec: string): boolean {
    const target = spec.replace(ALIAS_PREFIX, '');

    return (
        GIT_SPEC.test(spec) ||
        LOCAL_SPEC.test(target) ||
        GIT_SPEC.test(target) ||
        isGitRepositoryUrl(target)
    );
}

/**
 * An `http(s)` URL of a git repository rather than a tarball: any URL ending
 * in `.git`, and repository pages on the hosts npm knows. Archive URLs on
 * those hosts stay tarballs.
 */
function isGitRepositoryUrl(spec: string): boolean {
    let url: URL;
    try {
        url = new URL(spec);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return false;
    }
    if (url.pathname.endsWith('.git')) {
        return true;
    }

    const segments = url.pathname.split('/').filter((part) => part !== '');
    switch (url.hostname.replace(/^www\./, '')) {
        case 'github.com':
            return (
                segments.length === 2 ||
                (segments.length > 3 && segments[2] === 'tree')
            );
        case 'gist.github.com':
            return segments.length > 0;
        case 'gitlab.com':
            return (
                segments.length >= 2 &&
                !segments.includes('-') &&
                !url.pathname.endsWith('/archive.tar.gz')
            );
        case 'bitbucket.org':
            return segments.length >= 2 && segments[2] !== 'get';
        default:
            return false;
    }
}

function isInsideNodeModules(path: string): boolean {
    return path.split(sep).includes('node_modules');
}
