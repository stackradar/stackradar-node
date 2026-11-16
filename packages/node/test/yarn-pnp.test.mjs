// The yarn-pnp detector with a stand-in for Yarn's pnpapi. Packages live
// in placeholder zips under .yarn/cache, as in a real Plug'n'Play install.

import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, test } from 'node:test';

import { collectPackages } from '../dist/esm/node/packages.js';
import { registryVersion, walkPnp } from '../dist/esm/node/yarn-pnp.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stackradar-pnp-')));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/**
 * An app root with the given manifest and a pnpapi stand-in. `packages`
 * maps `name@reference` to `{ deps, zip?, directory?, manifest? }`: a
 * `zip` package is cached (its placeholder zip exists unless `fetched` is
 * false), a `directory` package is unplugged or a workspace with a real
 * package.json. `deps` is Yarn's map for the package: dependencies and
 * the peers Yarn resolved, `null` for an unmet one. `peers` is Yarn's
 * `packagePeers`, which the walk must not use to drop anything.
 */
function project(manifest, appDependencies, packages) {
    const root = join(base, `project-${(count += 1)}`);
    const write = (path, content) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    };
    write('package.json', JSON.stringify(manifest));

    const locations = {};
    for (const [key, entry] of Object.entries(packages)) {
        const name = key.slice(0, key.lastIndexOf('@'));
        if (entry.directory !== undefined) {
            write(
                `${entry.directory}/package.json`,
                JSON.stringify(entry.manifest ?? { name }),
            );
            locations[key] = join(root, entry.directory) + sep;
        } else {
            const zip = `.yarn/cache/${name.replace('/', '-')}-${key.length}.zip`;
            if (entry.fetched !== false) {
                write(zip, '');
            }
            locations[key] = join(root, zip, 'node_modules', name) + sep;
        }
    }

    const toMap = (deps = {}) => new Map(Object.entries(deps));
    const pnp = {
        findPackageLocator: (location) =>
            location === root + sep
                ? { name: 'app', reference: 'workspace:.' }
                : null,
        getPackageInformation: ({ name, reference }) => {
            if (name === 'app' && reference === 'workspace:.') {
                return {
                    packageLocation: root + sep,
                    packageDependencies: toMap(appDependencies),
                };
            }
            const key = `${name}@${reference}`;
            return packages[key] === undefined
                ? null
                : {
                      packageLocation: locations[key],
                      packageDependencies: toMap(packages[key].deps),
                      packagePeers: new Set(packages[key].peers ?? []),
                  };
        },
    };

    return { root, pnp };
}

const sorted = (packages) =>
    packages.map(({ name, version }) => `${name}@${version}`).sort();

test('the production tree resolves through pnpapi, aliases and duplicates included', async () => {
    const { root, pnp } = project(
        {
            name: 'app',
            dependencies: {
                debug: '4.3.7',
                ms: '2.0.0',
                'my-colors': 'npm:picocolors@1.1.1',
            },
            optionalDependencies: { kleur: '4.1.5', fsevents: '2.3.3' },
            devDependencies: { 'is-number': '7.0.0' },
        },
        {
            debug: 'npm:4.3.7',
            ms: 'npm:2.0.0',
            'my-colors': ['picocolors', 'npm:1.1.1'],
            kleur: 'npm:4.1.5',
            fsevents: 'npm:2.3.3',
            'is-number': 'npm:7.0.0',
        },
        {
            'debug@npm:4.3.7': {
                deps: { debug: 'npm:4.3.7', ms: 'npm:2.1.3' },
            },
            'ms@npm:2.1.3': {},
            'ms@npm:2.0.0': {},
            'picocolors@npm:1.1.1': {},
            'kleur@npm:4.1.5': {},
            // An optional dependency for another platform is never fetched.
            'fsevents@npm:2.3.3': { fetched: false },
            'is-number@npm:7.0.0': {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'debug@4.3.7',
        'kleur@4.1.5',
        'ms@2.0.0',
        'ms@2.1.3',
        'picocolors@1.1.1',
    ]);
});

test("workspace packages are skipped and followed; a package's resolved peers are followed", async () => {
    const { root, pnp } = project(
        {
            name: 'api',
            dependencies: { '@acme/shared': 'workspace:*', ui: '1.0.0' },
        },
        { '@acme/shared': 'workspace:packages/shared', ui: 'npm:1.0.0' },
        {
            '@acme/shared@workspace:packages/shared': {
                directory: 'packages/shared',
                manifest: {
                    name: '@acme/shared',
                    dependencies: { ms: '2.1.3' },
                },
                deps: { ms: 'npm:2.1.3' },
            },
            'ms@npm:2.1.3': {},
            'ui@npm:1.0.0': {
                directory: '.yarn/unplugged/ui-npm-1.0.0/node_modules/ui',
                manifest: {
                    name: 'ui',
                    peerDependencies: { react: '*', typescript: '*' },
                    peerDependenciesMeta: { typescript: { optional: true } },
                },
                deps: { react: 'npm:19.0.0', typescript: 'npm:5.6.3' },
            },
            'react@npm:19.0.0': {},
            'typescript@npm:5.6.3': {},
        },
    );

    const result = await walkPnp(root, pnp);

    // Yarn resolved both of ui's peers, so ui loads them.
    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'ms@2.1.3',
        'react@19.0.0',
        'typescript@5.6.3',
        'ui@1.0.0',
    ]);
});

test('peers as a real Yarn 4.18 full install resolves them, also when dev dependencies provide them', async () => {
    // Yarn's answers for the same manifests in a real install: the app's dev
    // dependencies provide lib's required peer debug and optional peer
    // kleur, and Yarn adds an unmet @types peer for each.
    const { root, pnp } = project(
        {
            name: 'app',
            dependencies: { lib: '1.0.0' },
            devDependencies: { kleur: '4.1.5', debug: '4.3.7' },
        },
        { lib: 'npm:1.0.0', kleur: 'npm:4.1.5', debug: 'npm:4.3.7' },
        {
            'lib@npm:1.0.0': {
                directory: '.yarn/unplugged/lib-npm-1.0.0/node_modules/lib',
                manifest: {
                    name: 'lib',
                    dependencies: { ms: '2.1.3' },
                    optionalDependencies: { picocolors: '1.1.1' },
                    peerDependencies: {
                        ms: '*',
                        picocolors: '*',
                        kleur: '*',
                        debug: '*',
                    },
                    peerDependenciesMeta: {
                        ms: { optional: true },
                        picocolors: { optional: true },
                        kleur: { optional: true },
                    },
                },
                peers: ['@types/debug', '@types/kleur', 'debug', 'kleur'],
                deps: {
                    '@types/debug': null,
                    '@types/kleur': null,
                    debug: 'npm:4.3.7',
                    kleur: 'npm:4.1.5',
                    ms: 'npm:2.1.3',
                    picocolors: 'npm:1.1.1',
                },
            },
            'ms@npm:2.1.3': {},
            'picocolors@npm:1.1.1': {},
            'kleur@npm:4.1.5': {},
            'debug@npm:4.3.7': {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'debug@4.3.7',
        'kleur@4.1.5',
        'lib@1.0.0',
        'ms@2.1.3',
        'picocolors@1.1.1',
    ]);
});

test('a dependency that is also a peer is listed at the version Yarn resolved, from a dev dependency too', async () => {
    // A real Yarn 4.18 install: lib asks for react 18.3.1 and also takes
    // it as a peer; the app's dev dependency react 19.2.0 provides it, and
    // Yarn maps lib's react to 19.2.0.
    const { root, pnp } = project(
        {
            name: 'app',
            dependencies: { lib: '1.0.0' },
            devDependencies: { react: '19.2.0' },
        },
        { lib: 'npm:1.0.0', react: 'npm:19.2.0' },
        {
            'lib@npm:1.0.0': {
                directory: '.yarn/unplugged/lib-npm-1.0.0/node_modules/lib',
                manifest: {
                    name: 'lib',
                    dependencies: { react: '18.3.1' },
                    peerDependencies: { react: '^18.0.0 || ^19.0.0' },
                },
                peers: ['@types/react', 'react'],
                deps: { '@types/react': null, react: 'npm:19.2.0' },
            },
            'react@npm:19.2.0': {},
            'react@npm:18.3.1': {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['lib@1.0.0', 'react@19.2.0']);
});

test("a package's dependency that is not installed: optional is fine, required makes the list partial", async () => {
    // Only then is the asking package's package.json read.
    const app = (name, manifest) =>
        project(
            { name: 'app', dependencies: { [name]: '1.0.0' } },
            { [name]: 'npm:1.0.0' },
            {
                [`${name}@npm:1.0.0`]: {
                    directory: `.yarn/unplugged/${name}/node_modules/${name}`,
                    manifest: { name, ...manifest },
                    deps: { fsevents: 'npm:2.3.3' },
                },
                'fsevents@npm:2.3.3': { fetched: false },
            },
        );
    const optional = app('watcher', {
        optionalDependencies: { fsevents: '2.3.3' },
    });
    const required = app('needy', { dependencies: { fsevents: '2.3.3' } });

    const optionalResult = await walkPnp(optional.root, optional.pnp);
    const requiredResult = await walkPnp(required.root, required.pnp);

    assert.equal(optionalResult.status, 'collected');
    assert.deepEqual(sorted(optionalResult.packages), ['watcher@1.0.0']);
    assert.equal(requiredResult.status, 'partial');
    assert.deepEqual(requiredResult.errors, [{ code: 'unresolved' }]);
});

test('a package one dependency asks for optionally and another requires is still missing', async () => {
    // Whichever asks first, the required edge makes the list partial.
    const { root, pnp } = project(
        { name: 'app', dependencies: { watcher: '1.0.0', needy: '1.0.0' } },
        { watcher: 'npm:1.0.0', needy: 'npm:1.0.0' },
        {
            'watcher@npm:1.0.0': {
                directory: '.yarn/unplugged/watcher/node_modules/watcher',
                manifest: {
                    name: 'watcher',
                    optionalDependencies: { fsevents: '2.3.3' },
                },
                deps: { fsevents: 'npm:2.3.3' },
            },
            'needy@npm:1.0.0': {
                directory: '.yarn/unplugged/needy/node_modules/needy',
                manifest: {
                    name: 'needy',
                    dependencies: { fsevents: '2.3.3' },
                },
                deps: { fsevents: 'npm:2.3.3' },
            },
            'fsevents@npm:2.3.3': { fetched: false },
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.errors, [{ code: 'unresolved' }]);
    assert.deepEqual(sorted(result.packages), ['needy@1.0.0', 'watcher@1.0.0']);
});

test('a workspace whose package.json cannot be read makes the list partial', async () => {
    // Which of its dependencies are production ones is then unknown.
    const { root, pnp } = project(
        { name: 'api', dependencies: { '@acme/shared': 'workspace:*' } },
        { '@acme/shared': 'workspace:packages/shared' },
        {
            '@acme/shared@workspace:packages/shared': {
                directory: 'packages/shared',
                deps: { ms: 'npm:2.1.3' },
            },
            'ms@npm:2.1.3': {},
        },
    );
    writeFileSync(join(root, 'packages/shared/package.json'), '{');

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.errors, [{ code: 'invalid_package' }]);
});

test('a missing dependency the app declares makes the list partial', async () => {
    const { root, pnp } = project(
        { name: 'app', dependencies: { debug: '4.3.7' } },
        { debug: 'npm:4.3.7' },
        { 'debug@npm:4.3.7': { fetched: false } },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'partial');
    assert.equal(result.declaredMissing, true);
});

test('an app root Yarn does not know falls back to the dependency-tree walk', async () => {
    const { root, pnp } = project({ name: 'app' }, {}, {});
    const unknown = { ...pnp, findPackageLocator: () => null };

    assert.equal(await walkPnp(root, unknown), null);
    assert.equal(
        (await collectPackages(root, {}, { pnp: unknown })).section.detector,
        'dependency-tree',
    );
    assert.equal(
        (await collectPackages(root, {}, { pnp })).section.detector,
        'yarn-pnp',
    );
});

test('registry versions come from Yarn references, including virtual and patched ones', () => {
    assert.equal(registryVersion('npm:4.17.21'), '4.17.21');
    assert.equal(registryVersion('virtual:0a1b2c#npm:1.2.3'), '1.2.3');
    assert.equal(
        registryVersion(
            'patch:resolve@npm%3A1.22.8#optional!builtin<compat/resolve>::version=1.22.8&hash=c3c19d',
        ),
        '1.22.8',
    );
    assert.equal(
        registryVersion(
            'patch:@scope/pkg@npm%3A2.0.0#./patches/pkg.patch::locator=app%40workspace%3A.',
        ),
        '2.0.0',
    );
    // Bindings such as a private registry's archive URL are not the version.
    const archive =
        '__archiveUrl=https%3A%2F%2Fnpm.example.com%2Fx%2F-%2Fx-1.2.3.tgz';
    assert.equal(registryVersion(`npm:1.2.3::${archive}`), '1.2.3');
    assert.equal(
        registryVersion(`virtual:0a1b2c#npm:1.2.3::${archive}`),
        '1.2.3',
    );
    assert.equal(
        registryVersion(
            `patch:x@${encodeURIComponent(`npm:1.2.3::${archive}`)}#./patches/x.patch::version=1.2.3&hash=c3c19d`,
        ),
        '1.2.3',
    );
    for (const local of [
        'workspace:.',
        'workspace:packages/shared',
        'file:../x#.',
        'link:../x',
        'portal:../x',
        'https://github.com/a/b.git#commit=abc',
        'npm:',
    ]) {
        assert.equal(registryVersion(local), null, local);
    }
});

test('a package with bindings in its reference is listed with its version only', async () => {
    const archive =
        '__archiveUrl=https%3A%2F%2Fnpm.example.com%2Fdebug%2F-%2Fdebug-4.3.7.tgz';
    const { root, pnp } = project(
        { name: 'app', dependencies: { debug: '4.3.7' } },
        { debug: `npm:4.3.7::${archive}` },
        {
            [`debug@npm:4.3.7::${archive}`]: {
                deps: { ms: `virtual:0a1b2c#npm:2.1.3::${archive}` },
            },
            [`ms@virtual:0a1b2c#npm:2.1.3::${archive}`]: {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['debug@4.3.7', 'ms@2.1.3']);
});

test('a dependency also declared as an optional peer is followed, for the app and for packages', async () => {
    const optionalPeer = (...names) => ({
        peerDependencies: Object.fromEntries(names.map((name) => [name, '*'])),
        peerDependenciesMeta: Object.fromEntries(
            names.map((name) => [name, { optional: true }]),
        ),
    });
    const { root, pnp } = project(
        {
            name: 'app',
            dependencies: { lib: '1.0.0', react: '19.0.0' },
            optionalDependencies: { kleur: '4.1.5' },
            ...optionalPeer('react', 'kleur'),
        },
        { lib: 'npm:1.0.0', react: 'npm:19.0.0', kleur: 'npm:4.1.5' },
        {
            'lib@npm:1.0.0': {
                directory: '.yarn/unplugged/lib-npm-1.0.0/node_modules/lib',
                manifest: {
                    name: 'lib',
                    dependencies: { ms: '2.1.3' },
                    optionalDependencies: { picocolors: '1.1.1' },
                    ...optionalPeer('ms', 'picocolors', 'typescript'),
                },
                // Nothing provides lib's optional peer typescript: unmet.
                deps: {
                    ms: 'npm:2.1.3',
                    picocolors: 'npm:1.1.1',
                    typescript: null,
                },
            },
            'react@npm:19.0.0': {},
            'kleur@npm:4.1.5': {},
            'ms@npm:2.1.3': {},
            'picocolors@npm:1.1.1': {},
            'typescript@npm:5.6.3': {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), [
        'kleur@4.1.5',
        'lib@1.0.0',
        'ms@2.1.3',
        'picocolors@1.1.1',
        'react@19.0.0',
    ]);
});

test("a workspace package's dev dependencies are not followed", async () => {
    // Yarn's map for a workspace holds its dev dependencies too.
    const shared = {
        directory: 'packages/shared',
        manifest: {
            name: '@acme/shared',
            dependencies: { ms: '2.1.3' },
            peerDependencies: { react: '*' },
            devDependencies: { typescript: '5.6.3' },
        },
        deps: {
            ms: 'npm:2.1.3',
            react: 'npm:19.0.0',
            typescript: 'npm:5.6.3',
        },
    };
    const { root, pnp } = project(
        {
            name: 'api',
            dependencies: {
                '@acme/shared': 'workspace:*',
                react: '19.0.0',
            },
        },
        {
            '@acme/shared': [
                '@acme/shared',
                'virtual:0a1b2c#workspace:packages/shared',
            ],
            react: 'npm:19.0.0',
        },
        {
            '@acme/shared@virtual:0a1b2c#workspace:packages/shared': shared,
            'ms@npm:2.1.3': {},
            'react@npm:19.0.0': {},
            'typescript@npm:5.6.3': {},
        },
    );

    const result = await walkPnp(root, pnp);

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['ms@2.1.3', 'react@19.0.0']);
});

test("a package's package.json is read once, however many of its optional dependencies are not installed", async (t) => {
    // Like sharp or next: one platform package per system, the rest absent.
    const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
    const packages = {
        'native@npm:1.0.0': {
            directory: '.yarn/unplugged/native/node_modules/native',
            manifest: {
                name: 'native',
                optionalDependencies: Object.fromEntries(
                    platforms.map((platform) => [
                        `@native/${platform}`,
                        '1.0.0',
                    ]),
                ),
            },
            deps: Object.fromEntries(
                platforms.map((platform) => [
                    `@native/${platform}`,
                    'npm:1.0.0',
                ]),
            ),
        },
    };
    for (const platform of platforms) {
        packages[`@native/${platform}@npm:1.0.0`] = { fetched: false };
    }
    const { root, pnp } = project(
        { name: 'app', dependencies: { native: '1.0.0' } },
        { native: 'npm:1.0.0' },
        packages,
    );
    const reads = [];
    const readFile = fsPromises.readFile;
    t.mock.method(fsPromises, 'readFile', function (path, ...rest) {
        reads.push(String(path));
        return readFile.call(this, path, ...rest);
    });
    syncBuiltinESMExports();

    let result;
    try {
        result = await walkPnp(root, pnp);
    } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    }

    assert.equal(result.status, 'collected');
    assert.deepEqual(sorted(result.packages), ['native@1.0.0']);
    assert.equal(
        reads.filter((path) => path.includes(`${sep}native${sep}package.json`))
            .length,
        1,
    );
});
