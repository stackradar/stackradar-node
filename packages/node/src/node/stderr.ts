import { writeSync } from 'node:fs';

/**
 * Best effort, straight to file descriptor 2. `process.stderr.write` reports
 * a closed pipe as an `error` event later, which would crash the app because
 * nothing listens for it; a synchronous write fails here, where it is caught,
 * and leaves the app's own stream and its listeners alone.
 */
export function writeToStderr(line: string): void {
    try {
        writeSync(2, `@stackradar/node: ${line}\n`);
    } catch {
        // A closed or full stderr loses the line, never the app.
    }
}
