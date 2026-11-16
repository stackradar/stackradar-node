import { withStackRadar } from '@stackradar/node/next';

export default withStackRadar(
    { output: 'standalone' },
    { dir: import.meta.dirname },
);
