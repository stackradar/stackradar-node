# StackRadar for Node.js

`@stackradar/node` reports which packages a production Node.js app is running to [StackRadar](https://stackradar.com/), so StackRadar can show where production differs from your repository.

It has no dependencies, patches nothing, and never throws into the app.

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
3. Turn it on with one line anywhere in the app:
   ```js
   import '@stackradar/node/register';
   ```

Next.js, other bundlers, configuration, what is sent, overhead and requirements are covered in the [package README](packages/node/README.md). Changes are listed in the [releases](https://github.com/stackradar/stackradar-node/releases).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
