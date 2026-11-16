# StackRadar for Node.js

`@stackradar/node` reports which packages a production Node.js app is running to [StackRadar](https://stackradar.com/). Setup, configuration and what is sent are in the [package README](packages/node/README.md).

## Repository

```text
packages/node/      the @stackradar/node package, its tests and CHANGELOG
scripts/            repository checks and release preparation
```

## Development

Use the Node.js version in `.nvmrc`. The package itself supports Node.js 18 and later.

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
npm run test:payload --workspace packages/node
npm run check:dependencies
npm run check:package-contents
```

CI also runs the tests on every supported Node.js version, a Next.js build, a Yarn Plug'n'Play install, Bun and Deno.

The package has no runtime dependencies. Every request the tests capture is checked against the JSON Schemas in `packages/node/test/schema/`, and the payload test fails on any field they do not list. To add a field, add it to its schema first.

## Releases

Maintainers start a release from the Prepare release workflow, which opens a pull request with the version and CHANGELOG section. A pull request opened by a workflow starts no checks, so close and reopen it once to run them. Merging it stages the version on npm from CI with provenance and creates a draft GitHub Release. A maintainer then approves the staged version with 2FA (`npm stage approve`), which makes it installable, and publishes the draft release, which creates the tag. Changes are listed in the [CHANGELOG](packages/node/CHANGELOG.md).

### First release

npm's trusted publishing can only be set up for a package that already exists, so the first version is published by hand:

1. Run the Prepare release workflow for `0.1.0`, edit the CHANGELOG section and merge the pull request. The publish workflow fails to stage it, as expected.
2. From that commit on `main`: `npm ci`, `npm run build`, `npm test` and `npm run check:package-contents`, then `npm publish --access public` in `packages/node`, with 2FA.
3. Create the release from that commit: `gh release create v0.1.0 --target <commit> --notes-file <the CHANGELOG section>`.
4. On npmjs.com, add `stackradar/stackradar-node`, workflow `publish.yml` and environment `npm` as the package's trusted publisher, and set "Require two-factor authentication and disallow tokens".

Once, in the repository settings: allow GitHub Actions to create pull requests, and give the `npm` environment required reviewers. Renovate needs its GitHub App installed and the `RENOVATE_APP_CLIENT_ID` variable and `RENOVATE_APP_PRIVATE_KEY` secret.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
