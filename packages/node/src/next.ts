/**
 * `withStackRadar()` for `next.config`: during `next build` it writes the
 * Build Inventory into the project and adds it to
 * `outputFileTracingIncludes`, so Next.js ships it in standalone output and
 * in Vercel functions. It never imports `next`, accepts a config object or a
 * config function, and never fails the build: its own problems are
 * warnings.
 */

import { writeBuildInventory } from './node/build-inventory-writer.js';
import { BUILD_INVENTORY_FILE } from './node/build-inventory.js';
import { writeToStderr } from './node/stderr.js';

export interface StackRadarNextOptions {
    /**
     * The Next.js project directory: `import.meta.dirname` in
     * `next.config.mjs`, or `__dirname` in a CommonJS config. Next.js does
     * not tell config wrappers where the project is.
     */
    dir: string;
}

type ConfigFunction<Config> = (
    phase: string,
    context: unknown,
) => Config | Promise<Config>;

const PRODUCTION_BUILD = 'phase-production-build';
const INCLUDE = `./${BUILD_INVENTORY_FILE}`;

export function withStackRadar<Config extends object>(
    nextConfig: Config | ConfigFunction<Config>,
    options?: StackRadarNextOptions,
): (phase: string, context: unknown) => Promise<Config> {
    return async (phase, context) => {
        // The app's own config function may throw; that is the app's error.
        const config =
            typeof nextConfig === 'function'
                ? await nextConfig(phase, context)
                : nextConfig;

        if (phase !== PRODUCTION_BUILD) {
            return config;
        }

        try {
            if (typeof options?.dir !== 'string' || options.dir === '') {
                writeToStderr(
                    'withStackRadar() needs the project directory: withStackRadar(config, { dir: import.meta.dirname }); no Build Inventory written',
                );
                return config;
            }

            const result = await writeBuildInventory({ appRoot: options.dir });
            if (result.warning !== undefined) {
                writeToStderr(result.warning);
            }

            return result.written ? withInclude(config) : config;
        } catch (error) {
            writeToStderr(
                `could not write the Build Inventory (${error instanceof Error ? error.message : String(error)}); the build goes on without it`,
            );
            return config;
        }
    };
}

/** Adds the file for every route, keeping the app's own entries. */
function withInclude<Config extends object>(config: Config): Config {
    const existing =
        (config as { outputFileTracingIncludes?: Record<string, string[]> })
            .outputFileTracingIncludes ?? {};
    const forAllRoutes = existing['/*'] ?? [];

    return {
        ...config,
        outputFileTracingIncludes: {
            ...existing,
            '/*': forAllRoutes.includes(INCLUDE)
                ? forAllRoutes
                : [...forAllRoutes, INCLUDE],
        },
    };
}
