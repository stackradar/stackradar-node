import createDebug from 'debug';

const log = createDebug('nextjs-app');

export const dynamic = 'force-dynamic';

export function GET() {
    log('hello');
    return Response.json({ enabled: log.enabled });
}
