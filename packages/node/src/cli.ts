#!/usr/bin/env node
/**
 * The `stackradar-node` command. Built as CommonJS only, so `__dirname` is
 * available.
 */
import { readFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';

import { resolveAppRoot } from './node/app-root.js';
import { writeBuildInventory } from './node/build-inventory-writer.js';
import { writeToStderr } from './node/stderr.js';

const USAGE = `Usage: stackradar-node <command>

Commands:
  build-inventory [--out <dir>]  Write the Build Inventory for the app in the
                                 current directory into <dir>, the app root of
                                 what ships (default: the app root)
  --version                      Print the version
  --help                         Show this help
`;

/**
 * Best effort, synchronous, like `writeToStderr()`: a closed pipe, as in
 * `stackradar-node build-inventory | head -0`, would otherwise raise an
 * `error` event later that crashes the build after its work is done.
 */
function print(fd: 1 | 2, text: string): void {
    try {
        writeSync(fd, text);
    } catch {
        // The output is lost, never the build.
    }
}

function version(): string {
    const manifest: unknown = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    );

    return typeof manifest === 'object' &&
        manifest !== null &&
        'version' in manifest &&
        typeof manifest.version === 'string'
        ? manifest.version
        : 'unknown';
}

/** `--out <dir>` or `--out=<dir>`; `null` for anything else. */
function outDirectory(args: string[]): string | undefined | null {
    if (args.length === 0) {
        return undefined;
    }
    if (args.length === 1 && args[0]?.startsWith('--out=')) {
        return args[0].slice('--out='.length) || null;
    }
    if (args.length === 2 && args[0] === '--out' && args[1] !== '') {
        return args[1];
    }

    return null;
}

/**
 * A build step: problems are warnings and the exit code stays 0, so the
 * Build Inventory never fails the build. Only a mistyped command line
 * fails.
 */
async function buildInventory(args: string[]): Promise<void> {
    const outDir = outDirectory(args);
    if (outDir === null) {
        print(2, USAGE);
        process.exitCode = 1;
        return;
    }

    try {
        const appRoot = await resolveAppRoot({
            configured: null,
            entry: undefined,
            cwd: process.cwd(),
        });
        if (appRoot === null) {
            writeToStderr(
                'no package.json with a name or dependencies here or above; no Build Inventory written',
            );
            return;
        }

        const result = await writeBuildInventory({
            appRoot: appRoot.path,
            ...(outDir === undefined ? {} : { outDir }),
        });
        if (result.warning !== undefined) {
            writeToStderr(result.warning);
        }
        if (result.written) {
            print(
                1,
                `Build Inventory: ${result.packages ?? 0} packages in ${relative(process.cwd(), result.path) || result.path}\n`,
            );
        }
    } catch (error) {
        writeToStderr(
            `could not write the Build Inventory (${error instanceof Error ? error.message : String(error)})`,
        );
    }
}

const [command, ...args] = process.argv.slice(2);

if (command === 'build-inventory') {
    void buildInventory(args);
} else if (command === '--version') {
    print(1, `${version()}\n`);
} else if (command === '--help') {
    print(1, USAGE);
} else {
    print(
        2,
        command === undefined
            ? USAGE
            : `Unknown command: ${command}\n\n${USAGE}`,
    );
    process.exitCode = 1;
}
