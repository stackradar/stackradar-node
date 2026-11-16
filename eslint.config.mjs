import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

export default defineConfig(
    {
        ignores: [
            '**/dist/**',
            'packages/node/test/fixtures/**',
            // A Next.js app with JSX, built by Next.js in its own test.
            'packages/node/test/nextjs-app/**',
        ],
    },
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    n.configs['flat/recommended'],
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        settings: {
            node: {
                // Lets the plugin see that src/cli.ts becomes the `bin` file.
                // Paths are relative to the package's own package.json.
                convertPath: {
                    'src/**/*.ts': ['^src/(.+)\\.ts$', 'dist/cjs/$1.js'],
                },
            },
        },
        rules: {
            // TypeScript resolves imports; the plugin cannot map `.js` to `.ts`.
            'n/no-missing-import': 'off',
        },
    },
    {
        // Repository scripts and tests run on the development Node.js version.
        files: ['**/*.{js,mjs,cjs}'],
        extends: [tseslint.configs.disableTypeChecked],
        settings: { node: { version: '>=24' } },
    },
    {
        // The package itself and its tests run on every supported version.
        files: ['packages/node/src/**', 'packages/node/test/**'],
        settings: { node: { version: '>=18.0.0' } },
    },
    {
        // Tests run on the latest release of each Node.js major, where
        // node:test exists; it is experimental on 18 but works there.
        files: ['packages/node/test/**'],
        settings: { node: { version: '>=18.19.0' } },
        rules: {
            'n/no-unsupported-features/node-builtins': [
                'error',
                { allowExperimental: true },
            ],
            // Tests load the build, which does not exist when lint runs first.
            'n/no-missing-require': 'off',
        },
    },
    {
        files: ['**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    prettier,
);
