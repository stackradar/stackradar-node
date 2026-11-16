# @stackradar/node

An npm package that runs inside production Node.js processes and reports their runtime and installed packages to StackRadar. The repository is a workspace with one package, `packages/node`.

## Layout

- `packages/node/src/core/`: runtime-independent code: configuration, the inventory hash, the report body and the reporting lifecycle.
- `packages/node/src/node/`: Node.js specifics: the app root, the dependency-tree walk, Yarn Plug'n'Play, the Build Inventory and the transport.
- `packages/node/src/next.ts`, `packages/node/src/cli.ts`: the Next.js config wrapper and the `stackradar-node build-inventory` command.
- `packages/node/test/`: tests, fixtures built from real installs, and the JSON Schemas of every request body in `test/schema/`.
- `scripts/`: repository checks.

## Checks

Use the Node.js version in `.nvmrc`. Before committing, run:

```sh
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
npm run test:payload --workspace packages/node
npm run check:dependencies
npm run check:package-contents
```

CI also runs the tests on every supported Node.js version, Bun, Deno, a Next.js build and a Yarn Plug'n'Play install. The package supports Node.js 18 and later.

## Rules

- **Zero runtime dependencies.** Only `node:` built-ins.
- **Never harm the host.** No error escapes an entry point. Nothing runs synchronously on the start-up path except reading configuration. Timers are unref'd. No signal handlers, no monkey-patching. The Build Inventory step never fails a build.
- **Collect and send, never interpret.** The reporter does no vulnerability matching and no version comparison.
- **Send only what the schemas list.** A new field is added to its schema in `packages/node/test/schema/` first. The payload test fails on any field the schema does not list.
- **Never present a partial package list as complete.**
- **Never log or expose the Ingest Key**, including in debug output.
- A change in behaviour comes with a test. Tests use made-up data.

## Pull requests

- `main` changes only through a pull request.
- Each pull request gets one label: `semver:major`, `semver:minor`, `semver:patch` or `semver:chore`. The draft release is built from them.
- `packages/node/package.json` stays at version `0.0.0`. The Release workflow sets the real version when it publishes.
- Maintainers publish releases. Never publish, tag or approve one.
