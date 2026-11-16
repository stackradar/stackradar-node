# @stackradar/node

Reports which packages a production Node.js app is running to [StackRadar](https://stackradar.com), so StackRadar can show where production differs from your repository.

The reporter patches nothing and loads no other packages: it has no dependencies. Shortly after the app starts it lists the app's production dependency tree once, sends a small report, and repeats that report every 10 minutes. It never changes how the app runs, and never throws into it.

**Status:** `0.x`, in beta. See [Versions](#versions).

## Setup

1. Install it:
   ```bash
   npm install @stackradar/node
   ```
2. Set two environment variables in each deployment environment. The Ingest Key comes from the Project's settings in StackRadar:
   ```bash
   STACKRADAR_INGEST_KEY=sr_ingest_…
   STACKRADAR_ENVIRONMENT=production
   ```
3. Turn it on, either with one line anywhere in the app:
   ```js
   import '@stackradar/node/register';
   ```
   or with no code changes, by setting one more environment variable:
   ```bash
   NODE_OPTIONS="--require @stackradar/node/register"
   ```

Without an Ingest Key the reporter does nothing, so the same build runs in development untouched.

For options in code, call `init()` instead. Options override environment variables:

```js
import { init } from '@stackradar/node';

init({ service: 'api' });
```

### Next.js

Wrap the config, so every `next build` writes a Build Inventory, the app's production packages as installed on the build machine, and ships it with the build:

```js
// next.config.mjs
import { withStackRadar } from '@stackradar/node/next';

export default withStackRadar({ output: 'standalone' }, { dir: import.meta.dirname });
```

`import.meta.dirname` needs Node.js 20.11 or later; before that, pass `fileURLToPath(new URL('.', import.meta.url))` from `node:url`.

Start the reporter from Next.js's start-up hook:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@stackradar/node/register');
  }
}
```

Reports are sent from a long-running server, `next start` or the standalone server. Serverless functions, including Vercel functions, do not report yet; see [Requirements](#requirements).

### Other bundlers

A bundled app's packages are no longer in `node_modules`. Run the command after the build and point it at the directory that ships:

```json
"build": "tsup && stackradar-node build-inventory --out dist"
```

The reporter looks for the Build Inventory beside the app's `package.json`, so the directory that ships needs that `package.json` too; copy it in if the bundler does not. Run the command from the installed package, through the package script, never as `npx @stackradar/node@latest`.

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `ingestKey` | `STACKRADAR_INGEST_KEY` | none: the reporter does nothing |
| `environment` | `STACKRADAR_ENVIRONMENT` | from `VERCEL_ENV` or `RAILWAY_ENVIRONMENT_NAME`; never `NODE_ENV` |
| `service` | `STACKRADAR_SERVICE` | `name` in the app's `package.json` |
| `release` | `STACKRADAR_RELEASE` | the commit, from common CI and hosting variables or `.git` |
| `artifact` | `STACKRADAR_ARTIFACT` | none |
| `root` | `STACKRADAR_ROOT` | the directory of the app's `package.json` |
| `debug` | `STACKRADAR_DEBUG` | `false` |

## What is sent

The runtime and its version, the deployment environment, the service, the release, a random ID for the process, and the list of installed packages with their versions. The list is sent only when StackRadar does not already have it. Never environment variables, command-line arguments, host names, absolute paths, file contents or credentials. When a file cannot be read, the report names it by its path relative to the app.

To see each request exactly as sent, with the Ingest Key hidden, set `STACKRADAR_DEBUG=1`.

Each process is one instance. Worker threads belong to their process and send nothing of their own; cluster and PM2 workers are processes, so each reports.

## Overhead

About 4 ms at start-up, then one walk of the dependency tree: 230 ms of wall time and under 20 MB of memory for an app with 1,000 production packages, and less under Yarn Plug'n'Play.

## Requirements

A long-running Node.js 18 or later process, such as a server or a worker. The first report is sent a few seconds after start-up, so serverless functions (including Vercel functions and AWS Lambda) and edge runtimes are not supported yet.

Bun is supported through its Node.js compatibility, and so is Deno with a `node_modules` directory. With Deno's global module cache the reporter finds no packages and reports `not_found`.

## Versions

While the version is `0.x`, a breaking change raises the minor version: `0.1.x` to `0.2.0`. npm's default `^0.1.0` range stays within `0.1.x`, so `npm update` never brings a breaking change. Every change is in the [releases](https://github.com/stackradar/stackradar-node/releases).

## License

[Apache-2.0](https://github.com/stackradar/stackradar-node/blob/main/packages/node/LICENSE)
