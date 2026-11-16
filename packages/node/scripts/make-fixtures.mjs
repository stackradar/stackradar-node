// Regenerates packages/node/test/fixtures/ from real installs.
//
// Every install runs in Docker (Linux, so `fsevents` is never installed),
// inside the container's own filesystem. The container writes tar files of
// the installed trees and the package managers' own answers about the
// production set to a mounted work directory. This script then copies each
// tree into `<fixture>/layout/`, keeping only package.json files (third-party
// ones trimmed), directories, symlinks and a few config files, and writes
// `<fixture>/fixture.json` with the expected package list.
//
// The expected lists come from the package managers (npm ls, pnpm list, or
// the on-disk set of a production install), never from a tree walk of ours.

import { execFileSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node packages/node/scripts/make-fixtures.mjs [options]

Regenerates packages/node/test/fixtures/ from scratch: runs each install in
Docker, copies the installed trees as small offline layouts and writes each
fixture's expected production package list to fixture.json.

Needs Docker and network access to the npm registry. Images used: node:24,
oven/bun:1.3.14, denoland/deno:latest.

Options:
  --only <job,...>   Run only these jobs (default: all). A job is one
                     container run and writes one or more fixtures. Jobs:
                     {JOBS}
  --help             Show this help.
`;

const TOOLS = {
    nodeImage: 'node:24',
    bunImage: 'oven/bun:1.3.14',
    denoImage: 'denoland/deno:latest',
    pnpm: '12.16.1',
    yarnClassic: '1.22.22',
    yarnBerry: '4.18.1',
    next: '16.4.5',
    react: '19.2.9',
};

const FIXTURES_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../test/fixtures',
);

// The project directory inside every container.
const CONTAINER_ROOT = '/w';

// Files kept in a layout besides package.json: they describe the layout.
const KEPT_FILES = new Set(['.yarnrc.yml', 'pnpm-workspace.yaml', 'deno.json']);

// Fields kept from a third-party package.json.
const TRIMMED_FIELDS = [
    'name',
    'version',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const APP = {
    name: 'fixture-app',
    version: '1.0.0',
    private: true,
    dependencies: {
        debug: '4.3.7',
        ms: '2.0.0',
        semver: '7.6.3',
        'my-colors': 'npm:picocolors@1.1.1',
    },
    optionalDependencies: { fsevents: '2.3.3', kleur: '4.1.5' },
    devDependencies: { 'is-number': '7.0.0' },
};

/**
 * @param {string} workspaceProtocol what apps/api uses for @acme/shared
 * @returns {Record<string, string>}
 */
const workspaceFiles = (workspaceProtocol) => ({
    'package.json': json({
        name: 'fixture-monorepo',
        private: true,
        workspaces: ['apps/*', 'packages/*'],
        devDependencies: { 'is-number': '7.0.0' },
    }),
    'apps/api/package.json': json({
        name: 'api',
        version: '1.0.0',
        dependencies: {
            debug: '4.3.7',
            '@acme/shared': workspaceProtocol,
        },
    }),
    'apps/web/package.json': json({
        name: 'web',
        version: '1.0.0',
        dependencies: {
            semver: '7.6.3',
            'my-colors': 'npm:picocolors@1.1.1',
        },
    }),
    'packages/shared/package.json': json({
        name: '@acme/shared',
        version: '1.0.0',
        dependencies: { ms: '2.1.3' },
    }),
});

const PNPM_WORKSPACE_YAML = 'packages:\n  - apps/*\n  - packages/*\n';

// Shell prelude for every job: copy the project into the container's own
// filesystem, and capture trees as tar files in /out.
const PRELUDE = `set -eu
cp -a /out/src ${CONTAINER_ROOT}
cd ${CONTAINER_ROOT}
capture() { tar -C "$2" -cf "/out/$1.tar" --exclude=./.yarn/cache --exclude=./.git .; }
uname -m > /out/arch.txt
`;

const PNPM = `/tools/pnpm/bin/pnpm --store-dir /tmp/pnpm-store`;
const PNPM_SETUP = `npm install -g --prefix /tools/pnpm --silent pnpm@${TOOLS.pnpm}
echo "pnpm $(/tools/pnpm/bin/pnpm -v)" > /out/version.txt
`;
const YARN_CLASSIC = '/tools/yarn/bin/yarn --cache-folder /tmp/yarn-cache';
const YARN_BERRY = '/tools/berry/bin/yarn';
const YARN_BERRY_SETUP = `npm install -g --prefix /tools/berry --silent @yarnpkg/cli-dist@${TOOLS.yarnBerry}
echo "yarn $(${YARN_BERRY} -v)" > /out/version.txt
export YARN_ENABLE_TELEMETRY=0
`;
const BUN_VERSION = 'echo "bun $(bun -v)" > /out/version.txt\n';
const CLEAN_NODE_MODULES =
    'rm -rf node_modules apps/*/node_modules packages/*/node_modules';

/**
 * A job is one container run. It writes `<name>.tar` captures and oracle
 * output files to /out.
 *
 * @type {Record<string, { image: string, files: Record<string, string>, script: string }>}
 */
const JOBS = {
    npm: {
        image: TOOLS.nodeImage,
        files: { 'package.json': json(APP) },
        script: `echo "npm $(npm -v)" > /out/version.txt
npm install --no-audit --no-fund
capture full ${CONTAINER_ROOT}
npm ls --omit=dev --all --long --json > /out/ls-full.json
rm -rf node_modules
npm ci --omit=dev --no-audit --no-fund
capture production ${CONTAINER_ROOT}
npm ls --omit=dev --all --long --json > /out/ls-production.json
`,
    },
    pnpm: {
        image: TOOLS.nodeImage,
        files: { 'package.json': json(APP) },
        script: `${PNPM_SETUP}
${PNPM} install --no-frozen-lockfile
capture full ${CONTAINER_ROOT}
${PNPM} list --prod --depth Infinity --json > /out/list-full.json
rm -rf node_modules
${PNPM} install --prod --frozen-lockfile
capture production ${CONTAINER_ROOT}
${PNPM} list --prod --depth Infinity --json > /out/list-production.json
`,
    },
    'yarn-classic': {
        image: TOOLS.nodeImage,
        files: { 'package.json': json(APP) },
        script: `npm install -g --prefix /tools/yarn --silent yarn@${TOOLS.yarnClassic}
echo "yarn $(/tools/yarn/bin/yarn -v)" > /out/version.txt
${YARN_CLASSIC} install --non-interactive
capture full ${CONTAINER_ROOT}
rm -rf node_modules
${YARN_CLASSIC} install --production --frozen-lockfile --non-interactive
capture production ${CONTAINER_ROOT}
`,
    },
    'yarn-berry-node-modules': {
        image: TOOLS.nodeImage,
        files: {
            'package.json': json(APP),
            '.yarnrc.yml':
                'nodeLinker: node-modules\nenableGlobalCache: false\n',
        },
        script: `${YARN_BERRY_SETUP}
${YARN_BERRY} install
capture full ${CONTAINER_ROOT}
rm -rf node_modules
${YARN_BERRY} workspaces focus --production
capture production ${CONTAINER_ROOT}
`,
    },
    bun: {
        image: TOOLS.bunImage,
        files: { 'package.json': json(APP) },
        script: `${BUN_VERSION}
bun install --linker hoisted
capture hoisted-full ${CONTAINER_ROOT}
rm -rf node_modules
bun install --linker hoisted --production --frozen-lockfile
capture hoisted-production ${CONTAINER_ROOT}
rm -rf node_modules
bun install --linker isolated --frozen-lockfile
capture isolated-full ${CONTAINER_ROOT}
rm -rf node_modules
bun install --linker isolated --production --frozen-lockfile
capture isolated-production ${CONTAINER_ROOT}
`,
    },
    deno: {
        image: TOOLS.denoImage,
        files: {
            'package.json': json(APP),
            'deno.json': json({ nodeModulesDir: 'manual' }),
        },
        script: `export DENO_DIR=/tmp/deno-dir DENO_NO_UPDATE_CHECK=1
deno --version | head -1 | cut -d ' ' -f 1-2 > /out/version.txt
deno install
capture full ${CONTAINER_ROOT}
# deno.lock does not mark dev dependencies, so a --prod install from it still
# installs them. The production set comes from a fresh --prod install instead.
rm -rf node_modules deno.lock
deno install --prod
capture production ${CONTAINER_ROOT}
`,
    },
    'npm-workspace': {
        image: TOOLS.nodeImage,
        files: workspaceFiles('*'),
        script: `echo "npm $(npm -v)" > /out/version.txt
npm install --no-audit --no-fund
capture full ${CONTAINER_ROOT}
npm ls --omit=dev --all --long --json --workspace api > /out/ls-api.json
npm ls --omit=dev --all --long --json --workspace web > /out/ls-web.json
`,
    },
    'pnpm-workspace': {
        image: TOOLS.nodeImage,
        files: {
            ...workspaceFiles('workspace:*'),
            'pnpm-workspace.yaml': PNPM_WORKSPACE_YAML,
        },
        script: `${PNPM_SETUP}
${PNPM} install --no-frozen-lockfile
capture full ${CONTAINER_ROOT}
${PNPM} --filter api list --prod --depth Infinity --json > /out/list-api.json
${PNPM} --filter web list --prod --depth Infinity --json > /out/list-web.json
`,
    },
    'pnpm-deploy': {
        image: TOOLS.nodeImage,
        files: {
            ...workspaceFiles('workspace:*'),
            'pnpm-workspace.yaml': `${PNPM_WORKSPACE_YAML}injectWorkspacePackages: true\n`,
        },
        script: `${PNPM_SETUP}
${PNPM} install --no-frozen-lockfile
${PNPM} --filter api deploy --prod /deploy
capture deploy /deploy
cd /deploy
${PNPM} list --prod --depth Infinity --json > /out/list-deploy.json
`,
    },
    'yarn-berry-workspace': {
        image: TOOLS.nodeImage,
        files: {
            ...workspaceFiles('workspace:*'),
            '.yarnrc.yml':
                'nodeLinker: node-modules\nenableGlobalCache: false\n',
        },
        script: `${YARN_BERRY_SETUP}
${YARN_BERRY} install
capture full ${CONTAINER_ROOT}
${CLEAN_NODE_MODULES}
${YARN_BERRY} workspaces focus --production api
capture focus-api ${CONTAINER_ROOT}
${CLEAN_NODE_MODULES}
${YARN_BERRY} workspaces focus --production web
capture focus-web ${CONTAINER_ROOT}
`,
    },
    'bun-workspace': {
        image: TOOLS.bunImage,
        files: workspaceFiles('workspace:*'),
        script: `${BUN_VERSION}
bun install
capture full ${CONTAINER_ROOT}
${CLEAN_NODE_MODULES}
bun install --production --frozen-lockfile --filter api
capture filter-api ${CONTAINER_ROOT}
${CLEAN_NODE_MODULES}
bun install --production --frozen-lockfile --filter web
capture filter-web ${CONTAINER_ROOT}
`,
    },
    'nextjs-standalone': {
        image: TOOLS.nodeImage,
        files: {
            'package.json': json({
                name: 'fixture-next-app',
                version: '1.0.0',
                private: true,
                dependencies: {
                    debug: '4.3.7',
                    next: TOOLS.next,
                    react: TOOLS.react,
                    'react-dom': TOOLS.react,
                },
            }),
            'next.config.mjs': "export default { output: 'standalone' };\n",
            'app/layout.js':
                'export default function RootLayout({ children }) {\n    return (\n        <html lang="en">\n            <body>{children}</body>\n        </html>\n    );\n}\n',
            'app/page.js':
                'export default function Page() {\n    return <p>fixture</p>;\n}\n',
            'app/api/hello/route.js':
                "import createDebug from 'debug';\n\nconst log = createDebug('fixture');\n\nexport const dynamic = 'force-dynamic';\n\nexport function GET() {\n    log('hello');\n    return Response.json({ enabled: log.enabled });\n}\n",
        },
        script: `echo "npm $(npm -v)" > /out/version.txt
export NEXT_TELEMETRY_DISABLED=1
npm install --no-audit --no-fund
npx next build
capture standalone ${CONTAINER_ROOT}/.next/standalone
`,
    },
};

const FULL_INSTALL_NOTE =
    'The layout is the full install: dev-only is-number is on disk and must not be reported.';

// What the spec says each app's production tree holds, written by hand from
// the declared dependencies. Used only to flag an oracle that disagrees.
const SPEC = {
    '.': 'debug@4.3.7, kleur@4.1.5, ms@2.0.0, ms@2.1.3, picocolors@1.1.1, semver@7.6.3',
    'apps/api': 'debug@4.3.7, ms@2.1.3',
    'apps/web': 'picocolors@1.1.1, semver@7.6.3',
    'pnpm-deploy:.': 'debug@4.3.7, ms@2.1.3',
    // Deno does not install the root optionalDependencies (kleur).
    'deno:.': 'debug@4.3.7, ms@2.0.0, ms@2.1.3, picocolors@1.1.1, semver@7.6.3',
    'nextjs-standalone:.': null,
};

/**
 * Each fixture: which job and capture it comes from, its app roots, and how
 * each app's expected list is obtained from the job's raw output.
 */
const FIXTURES = [
    npmFixture('npm', 'full', 'npm install'),
    npmFixture('npm-production', 'production', 'npm ci --omit=dev'),
    pnpmFixture('pnpm', 'full', 'pnpm install'),
    pnpmFixture('pnpm-production', 'production', 'pnpm install --prod'),
    yarnClassicFixture('yarn-classic', 'full', 'yarn install'),
    yarnClassicFixture(
        'yarn-classic-production',
        'production',
        'yarn install --production --frozen-lockfile',
    ),
    yarnBerryFixture('yarn-berry-node-modules', 'full', 'yarn install'),
    yarnBerryFixture(
        'yarn-berry-node-modules-production',
        'production',
        'yarn workspaces focus --production',
    ),
    bunFixture(
        'bun-hoisted',
        'hoisted',
        'full',
        'bun install --linker hoisted',
    ),
    bunFixture(
        'bun-hoisted-production',
        'hoisted',
        'production',
        'bun install --linker hoisted --production --frozen-lockfile',
    ),
    bunFixture(
        'bun-isolated',
        'isolated',
        'full',
        'bun install --linker isolated --frozen-lockfile',
    ),
    bunFixture(
        'bun-isolated-production',
        'isolated',
        'production',
        'bun install --linker isolated --production --frozen-lockfile',
    ),
    {
        name: 'deno',
        job: 'deno',
        capture: 'full',
        layout: 'isolated (node_modules/.deno store)',
        install: 'deno install (deno.json: { "nodeModulesDir": "manual" })',
        apps: [{ appRoot: '.', expected: diskSet('production') }],
        oracle: 'On-disk set of a fresh `deno install --prod` (no deno.lock, no node_modules; every version in package.json is exact): every package directory under node_modules, including the .deno store, de-duplicated by name and version.',
        notes: '`nodeModulesDir: "manual"` with `deno install` writes a real node_modules ("auto" gives the same tree): isolated, packages live in node_modules/.deno/<name>@<version>/node_modules/<name> and top-level entries are symlinks into it. Deno does not install the root package.json optionalDependencies at all: neither kleur nor fsevents is on disk, so kleur is correctly absent from the expected list (an optional dependency whose folder does not exist is left out). Deno also links the alias target by its real name: node_modules has both my-colors and picocolors pointing at picocolors@1.1.1. deno.lock does not record which dependencies are dev-only, so `deno install --prod --frozen-lockfile` from the full install\'s lockfile still installs is-number; the oracle therefore uses a fresh --prod install. The layout is the full install, so dev-only is-number is on disk and must not be reported.',
    },
    {
        name: 'npm-workspace',
        job: 'npm-workspace',
        capture: 'full',
        layout: 'hoisted, workspaces',
        install: 'npm install',
        apps: [
            { appRoot: 'apps/api', expected: npmLs('ls-api.json') },
            { appRoot: 'apps/web', expected: npmLs('ls-web.json') },
        ],
        oracle: "`npm ls --omit=dev --all --long --json --workspace <app>`, names and versions read from each listed path's own package.json; the workspace packages themselves left out.",
        notes: 'npm does not support the `workspace:` protocol, so apps/api declares "@acme/shared": "*". npm links it as node_modules/@acme/shared -> ../../packages/shared: a real path outside node_modules, which is what makes it a local package under §5. Root devDependency is-number is installed and must not be reported.',
    },
    {
        name: 'pnpm-workspace',
        job: 'pnpm-workspace',
        capture: 'full',
        layout: 'isolated, workspaces',
        install: 'pnpm install',
        apps: [
            {
                appRoot: 'apps/api',
                expected: pnpmList('list-api.json'),
            },
            { appRoot: 'apps/web', expected: pnpmList('list-web.json') },
        ],
        oracle: "`pnpm --filter <app> list --prod --depth Infinity --json`, names and versions read from each listed path's own package.json; workspace (`link:`) packages left out. pnpm lists @acme/shared's own dependencies under it.",
        notes: '',
    },
    {
        name: 'pnpm-deploy',
        job: 'pnpm-deploy',
        capture: 'deploy',
        layout: 'isolated, output of pnpm deploy',
        install:
            'pnpm install && pnpm --filter api deploy --prod <dir> (pnpm-workspace.yaml: injectWorkspacePackages: true)',
        apps: [
            {
                appRoot: '.',
                expected: pnpmList('list-deploy.json'),
                handFix: (packages) => ({
                    packages: packages.filter((p) => p.name !== '@acme/shared'),
                    note: 'Hand fix: `pnpm list` reports the injected workspace package @acme/shared (version "file:///w/packages/shared"; its package.json says 1.0.0). It is a workspace package, so it is removed from the expected list.',
                }),
            },
        ],
        oracle: "`pnpm list --prod --depth Infinity --json` run inside the deploy directory, names and versions read from each listed path's own package.json; workspace packages left out (see the hand fix).",
        notes: 'pnpm 12 deploy needs injectWorkspacePackages: true (or --legacy, which still exists; not used here). The layout is the deploy directory only, with the pnpm-workspace.yaml pnpm wrote there. Surprise for §5: deploy rewrites the workspace dependency in the deployed package.json to "@acme/shared": "@acme/shared@file:///w/packages/shared" (an absolute container path, /w, in a specifier that does not start with `file:`) and copies @acme/shared into node_modules/.pnpm/@acme+shared@file++++w+packages+shared/, a real path inside node_modules. A walk that only checks for a `file:` prefix and for a real path outside node_modules reports @acme/shared@1.0.0; the expected list leaves it out.',
    },
    {
        name: 'yarn-berry-workspace',
        job: 'yarn-berry-workspace',
        capture: 'full',
        layout: 'hoisted (nodeLinker: node-modules), workspaces',
        install: 'yarn install',
        apps: [
            { appRoot: 'apps/api', expected: diskSet('focus-api') },
            { appRoot: 'apps/web', expected: diskSet('focus-web') },
        ],
        oracle: 'On-disk set after `yarn workspaces focus --production <app>` from the same yarn.lock (node_modules removed first): every package directory under node_modules; symlinked workspace packages left out.',
        notes: 'Everything is hoisted to the root node_modules; workspaces are symlinked there (node_modules/api, node_modules/@acme/shared -> ../../packages/shared). From apps/api, debug resolves from the root node_modules.',
    },
    {
        name: 'bun-workspace',
        job: 'bun-workspace',
        capture: 'full',
        layout: "isolated (Bun's default for workspaces; node_modules/.bun store), workspaces",
        install: 'bun install',
        apps: [
            { appRoot: 'apps/api', expected: diskSet('filter-api') },
            { appRoot: 'apps/web', expected: diskSet('filter-web') },
        ],
        oracle: 'On-disk set after `bun install --production --frozen-lockfile --filter <app>` from the same bun.lock (node_modules removed first): every package directory under any node_modules, including the .bun store; symlinked workspace packages left out.',
        notes: 'Each workspace has its own node_modules with symlinks into the root node_modules/.bun store, which also holds a node_modules/.bun/node_modules folder of hoisted symlinks.',
    },
    {
        name: 'nextjs-standalone',
        job: 'nextjs-standalone',
        capture: 'standalone',
        layout: 'Next.js output: standalone (.next/standalone, traced node_modules)',
        install:
            'npm install && next build (next.config.mjs: output: "standalone")',
        status: 'partial',
        emptyFiles: ['server.js'],
        apps: [{ appRoot: '.', expected: diskSet('standalone') }],
        oracle: 'On-disk set of the standalone output: every package directory under .next/standalone/node_modules.',
        notes: "Only .next/standalone/ is kept, with an empty server.js where Next.js wrote the real one (at runtime it sets __NEXT_PRIVATE_STANDALONE_CONFIG). debug 4.3.7 is a declared production dependency imported from app/api/hello/route.js; Next.js bundles it into .next/server/chunks, so it is absent from the standalone node_modules and the walk must report `partial`. Other declared dependencies that are not traced and so do not resolve: next -> postcss, caniuse-lite, baseline-browser-mapping; @swc/helpers -> tslib; react-dom -> scheduler. Next.js also ships vendored copies under node_modules/next/dist/compiled/<name>/package.json (some with a name, such as debug); they are not in a node_modules folder and are not packages of the app. sharp's platform packages (@img/sharp-linux-<arch>, @img/sharp-libvips-linux-<arch>) depend on the build machine's architecture.",
    },
];

function npmFixture(name, capture, install) {
    return {
        name,
        job: 'npm',
        capture,
        layout: 'hoisted',
        install,
        apps: [{ appRoot: '.', expected: npmLs(`ls-${capture}.json`) }],
        oracle: "`npm ls --omit=dev --all --long --json` on this install, names and versions read from each listed path's own package.json.",
        notes: capture === 'full' ? FULL_INSTALL_NOTE : '',
    };
}

function pnpmFixture(name, capture, install) {
    return {
        name,
        job: 'pnpm',
        capture,
        layout: 'isolated (node_modules/.pnpm store)',
        install,
        apps: [{ appRoot: '.', expected: pnpmList(`list-${capture}.json`) }],
        oracle: "`pnpm list --prod --depth Infinity --json` on this install, names and versions read from each listed path's own package.json.",
        notes: capture === 'full' ? FULL_INSTALL_NOTE : '',
    };
}

function yarnClassicFixture(name, capture, install) {
    return {
        name,
        job: 'yarn-classic',
        capture,
        layout: 'hoisted',
        install,
        apps: [{ appRoot: '.', expected: diskSet('production') }],
        oracle: 'On-disk set of `yarn install --production --frozen-lockfile` from the same yarn.lock: every package directory under node_modules, de-duplicated by name and version.',
        notes: capture === 'full' ? FULL_INSTALL_NOTE : '',
    };
}

function yarnBerryFixture(name, capture, install) {
    return {
        name,
        job: 'yarn-berry-node-modules',
        capture,
        layout: 'hoisted (nodeLinker: node-modules)',
        install,
        apps: [{ appRoot: '.', expected: diskSet('production') }],
        oracle: 'On-disk set of `yarn workspaces focus --production` from the same yarn.lock: every package directory under node_modules, de-duplicated by name and version.',
        notes: capture === 'full' ? FULL_INSTALL_NOTE : '',
    };
}

function bunFixture(name, linker, capture, install) {
    return {
        name,
        job: 'bun',
        capture: `${linker}-${capture}`,
        layout:
            linker === 'isolated'
                ? 'isolated (node_modules/.bun store)'
                : linker,
        install,
        apps: [{ appRoot: '.', expected: diskSet(`${linker}-production`) }],
        oracle: `On-disk set of \`bun install --linker ${linker} --production --frozen-lockfile\` from the same bun.lock: every package directory under node_modules, including the .bun store, de-duplicated by name and version.`,
        notes: capture === 'full' ? FULL_INSTALL_NOTE : '',
    };
}

// ---------------------------------------------------------------------------
// Oracles. Each returns a function of the job's raw output directory that
// gives the expected packages and any notes about hand fixes.

/**
 * Packages listed by `npm ls --long --json`, read from each path's own
 * package.json. Workspace packages (real path outside node_modules) are
 * left out; npm lists their dependencies under them.
 */
function npmLs(file) {
    return (raw) => {
        const tree = JSON.parse(readFileSync(path.join(raw.dir, file), 'utf8'));
        const paths = [];
        const visit = (node) => {
            for (const child of Object.values(node.dependencies ?? {})) {
                if (child.missing) {
                    continue;
                }
                paths.push(child.path);
                visit(child);
            }
        };
        visit(tree);
        return packagesAt(raw, paths, '`npm ls`');
    };
}

/**
 * Packages listed by `pnpm list --json`, read from each path's own
 * package.json.
 */
function pnpmList(file) {
    return (raw) => {
        const paths = [];
        const visit = (node) => {
            for (const key of ['dependencies', 'optionalDependencies']) {
                for (const child of Object.values(node[key] ?? {})) {
                    paths.push(child.path);
                    visit(child);
                }
            }
        };
        const projects = JSON.parse(
            readFileSync(path.join(raw.dir, file), 'utf8'),
        );
        projects.forEach(visit);
        return packagesAt(raw, paths, '`pnpm list`');
    };
}

/**
 * Every package directory on disk in a capture: a real directory with a
 * package.json directly in a node_modules directory (or in a scope folder
 * there). Symlinks are not followed, so linked workspace packages and store
 * links are not counted twice; the real directories are.
 */
function diskSet(capture) {
    return (raw) => {
        const root = raw.extract(capture);
        const found = [];
        const visit = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const full = path.join(dir, entry.name);
                const parent = path.basename(dir);
                const inNodeModules =
                    parent === 'node_modules' ||
                    (parent.startsWith('@') &&
                        path.basename(path.dirname(dir)) === 'node_modules');
                if (
                    inNodeModules &&
                    !entry.name.startsWith('.') &&
                    !entry.name.startsWith('@') &&
                    existsSync(path.join(full, 'package.json'))
                ) {
                    found.push(readManifest(full));
                }
                visit(full);
            }
        };
        visit(root);
        return { packages: finish(found), notes: [] };
    };
}

function packagesAt(raw, containerPaths, tool) {
    const found = [];
    const notes = [];
    for (const containerPath of new Set(containerPaths)) {
        if (!containerPath) {
            continue;
        }
        const hostPath = raw.toHost(containerPath);
        if (!existsSync(path.join(hostPath, 'package.json'))) {
            notes.push(
                `${tool} lists ${path.relative(CONTAINER_ROOT, containerPath)}, which is not installed; left out.`,
            );
            continue;
        }
        // Workspace and local packages: real path outside every node_modules.
        const real = path.relative(raw.root(hostPath), realpathSync(hostPath));
        if (!real.split(path.sep).includes('node_modules')) {
            continue;
        }
        found.push(readManifest(hostPath));
    }
    return { packages: finish(found), notes };
}

function readManifest(dir) {
    const { name, version } = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    return { name, version };
}

const sortKey = ({ name, version }) => Buffer.from(`${name}\t${version}`);

function finish(packages) {
    const unique = new Map();
    for (const pkg of packages) {
        unique.set(`${pkg.name}\t${pkg.version}`, pkg);
    }
    return [...unique.values()].sort((a, b) =>
        Buffer.compare(sortKey(a), sortKey(b)),
    );
}

// ---------------------------------------------------------------------------
// Running jobs and building layouts.

function runJob(name, jobDir) {
    const job = JOBS[name];
    rmSync(jobDir, { recursive: true, force: true });
    for (const [file, content] of Object.entries(job.files)) {
        const target = path.join(jobDir, 'src', file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    writeFileSync(path.join(jobDir, 'run.sh'), PRELUDE + job.script);
    console.log(`[${name}] installing in ${job.image}`);
    execFileSync(
        'docker',
        [
            'run',
            '--rm',
            '-v',
            `${jobDir}:/out`,
            '--entrypoint',
            'sh',
            job.image,
            '/out/run.sh',
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] },
    );
}

function rawOutput(jobDir, containerRoot) {
    const extracted = new Map();
    const extract = (capture) => {
        if (!extracted.has(capture)) {
            const dir = path.join(jobDir, 'extract', capture);
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            execFileSync('tar', [
                '-xf',
                path.join(jobDir, `${capture}.tar`),
                '-C',
                dir,
            ]);
            extracted.set(capture, dir);
        }
        return extracted.get(capture);
    };
    return {
        dir: jobDir,
        extract,
        // Oracle paths name the container filesystem; the matching capture
        // holds the same tree.
        toHost(containerPath) {
            const [capture, prefix] = containerRoot(containerPath);
            return path.join(
                extract(capture),
                path.relative(prefix, containerPath),
            );
        },
        // The extracted capture a host path lies in.
        root(hostPath) {
            return realpathSync(
                [...extracted.values()].find((dir) =>
                    hostPath.startsWith(dir + path.sep),
                ),
            );
        },
    };
}

/**
 * Copies an installed tree, keeping directories, symlinks (relative targets
 * only), package.json files and KEPT_FILES. A package.json inside a
 * node_modules directory is trimmed to TRIMMED_FIELDS. Empty directories are
 * dropped, since git cannot keep them.
 */
function copyLayout(source, target, { emptyFiles = [] } = {}) {
    const copy = (from, to, relative) => {
        const stat = lstatSync(from);
        const base = path.basename(from);
        if (stat.isSymbolicLink()) {
            const link = readlinkSync(from);
            if (path.isAbsolute(link)) {
                throw new Error(`${relative}: absolute symlink ${link}`);
            }
            symlinkSync(link, to);
            return true;
        }
        if (stat.isDirectory()) {
            if (base === '.bin' || base === '.git') {
                return false;
            }
            mkdirSync(to);
            let kept = false;
            for (const entry of readdirSync(from).sort()) {
                kept =
                    copy(
                        path.join(from, entry),
                        path.join(to, entry),
                        path.join(relative, entry),
                    ) || kept;
            }
            if (!kept) {
                rmSync(to, { recursive: true });
            }
            return kept;
        }
        if (emptyFiles.includes(relative)) {
            writeFileSync(to, '');
            return true;
        }
        if (base === 'package.json') {
            const manifest = JSON.parse(readFileSync(from, 'utf8'));
            const thirdParty = relative
                .split(path.sep)
                .includes('node_modules');
            writeFileSync(to, json(thirdParty ? trim(manifest) : manifest));
            return true;
        }
        if (KEPT_FILES.has(base)) {
            writeFileSync(to, readFileSync(from));
            return true;
        }
        return false;
    };
    mkdirSync(path.dirname(target), { recursive: true });
    copy(source, target, '');
}

function trim(manifest) {
    const trimmed = {};
    for (const field of TRIMMED_FIELDS) {
        if (field in manifest) {
            trimmed[field] = manifest[field];
        }
    }
    return trimmed;
}

// ---------------------------------------------------------------------------

function parseArguments(argv) {
    const options = { only: Object.keys(JOBS), help: false };
    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else if (argument === '--only') {
            options.only = argv[++i].split(',');
        } else {
            throw new Error(`Unknown option ${argument}; see --help`);
        }
    }
    for (const name of options.only) {
        if (!(name in JOBS)) {
            throw new Error(`Unknown job ${name}; see --help`);
        }
    }
    return options;
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        console.log(HELP.replace('{JOBS}', Object.keys(JOBS).join(', ')));
        return;
    }
    // The repository ignores dist/; Next.js keeps package.json files in
    // node_modules/next/dist/compiled/, which belong to its fixture.
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(
        path.join(FIXTURES_DIR, '.gitignore'),
        '# Installed trees: keep them as the package managers wrote them.\n!dist/\n',
    );
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'fixtures-'));
    let mismatches = 0;

    try {
        for (const jobName of options.only) {
            const jobDir = path.join(workDir, jobName);
            runJob(jobName, jobDir);
            const read = (file) =>
                readFileSync(path.join(jobDir, file), 'utf8').trim();
            const context = {
                // Oracle paths name the container filesystem: deploy output
                // is in /deploy, everything else is the fixture's capture.
                raw: (capture) =>
                    rawOutput(jobDir, (containerPath) =>
                        containerPath.startsWith('/deploy')
                            ? ['deploy', '/deploy']
                            : [capture, CONTAINER_ROOT],
                    ),
                version: read('version.txt'),
                arch: read('arch.txt'),
            };
            for (const fixture of FIXTURES.filter((f) => f.job === jobName)) {
                mismatches += buildFixture(fixture, context);
            }
        }
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
    if (mismatches > 0) {
        console.error(
            `${mismatches} expected list(s) differ from the app's declared production tree; see the warnings above.`,
        );
        process.exitCode = 1;
    }
}

/**
 * Builds one fixture directory and returns how many of its apps' expected
 * lists differ from the hand-written SPEC list (a check on the oracle; the
 * fixture.json keeps the oracle's answer plus any recorded hand fix).
 */
function buildFixture(fixture, { raw, version, arch }) {
    const fixtureDir = path.join(FIXTURES_DIR, fixture.name);
    rmSync(fixtureDir, { recursive: true, force: true });
    const output = raw(fixture.capture);
    const layoutDir = path.join(fixtureDir, 'layout');
    copyLayout(output.extract(fixture.capture), layoutDir, {
        emptyFiles: fixture.emptyFiles ?? [],
    });
    const notes = [fixture.notes];

    let mismatches = 0;
    const apps = fixture.apps.map(({ appRoot, expected, handFix }) => {
        const result = expected(output);
        notes.push(...result.notes);
        let packages = result.packages;
        if (handFix) {
            const fixed = handFix(packages);
            packages = finish(fixed.packages);
            notes.push(fixed.note);
        }
        const jobKey = `${fixture.job}:${appRoot}`;
        const spec = jobKey in SPEC ? SPEC[jobKey] : SPEC[appRoot];
        if (spec && formatList(packages) !== spec) {
            console.warn(
                `WARNING [${fixture.name}] ${appRoot}: expected ${formatList(packages)}, the declared tree gives ${spec}`,
            );
            mismatches++;
        }
        return { appRoot, status: fixture.status ?? 'collected', packages };
    });

    const description = {
        packageManager: version,
        layout: fixture.layout,
        install: fixture.install,
        apps,
        oracle: fixture.oracle,
        notes: [...notes, `Installed on Linux ${arch} in Docker.`]
            .filter(Boolean)
            .join(' '),
    };
    writeFileSync(
        path.join(fixtureDir, 'fixture.json'),
        formatFixture(description),
    );
    console.log(
        `[${fixture.name}] ${apps.map((a) => `${a.appRoot}: ${a.packages.length} ${a.status}`).join(', ')}`,
    );
    return mismatches;
}

const formatList = (packages) =>
    packages.map(({ name, version }) => `${name}@${version}`).join(', ');

/** Pretty JSON with one package per line. */
function formatFixture(description) {
    return json(description).replace(
        /\{\n\s+"name": ("[^"]*"),\n\s+"version": ("[^"]*")\n\s+\}/g,
        '{ "name": $1, "version": $2 }',
    );
}

main();
