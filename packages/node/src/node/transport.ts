/**
 * Sends one request to the ingest address with `node:https` (`node:http`
 * for a test address), plain JSON, through Node.js's default agent, so a
 * proxy set with `NODE_USE_ENV_PROXY=1` (Node.js 22.21 and later) applies.
 * One deadline covers the whole request, from connecting to the end of the
 * response. A request in flight never keeps the process alive.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { clearTimeout, setTimeout } from 'node:timers';

import type { IngestResponse, Send } from '../core/lifecycle.js';

const TIMEOUT_MILLISECONDS = 10_000;
/** Error bodies are small; anything longer is not read further. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** A `Retry-After` longer than this is capped. */
const MAX_RETRY_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface TransportOptions {
    ingestUrl: string;
    ingestKey: string;
    userAgent: string;
    timeoutMilliseconds?: number;
    now?: () => number;
    /**
     * In debug mode: prints every request exactly as sent, with the
     * Ingest Key hidden. Sending is unchanged.
     */
    log?: (message: string) => void;
}

export function createSend({
    ingestUrl,
    ingestKey,
    userAgent,
    timeoutMilliseconds = TIMEOUT_MILLISECONDS,
    now = Date.now,
    log,
}: TransportOptions): Send {
    return ({ method, path, body }) =>
        new Promise<IngestResponse>((resolve, reject) => {
            const url = new URL(path, ingestUrl);
            const headers = {
                authorization: `Bearer ${ingestKey}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body, 'utf8'),
                'user-agent': userAgent,
            };
            if (log !== undefined) {
                log(`request: ${method} ${url.href}`);
                log(
                    `headers: ${JSON.stringify({ ...headers, authorization: 'Bearer [hidden]' })}`,
                );
                log(`body: ${body}`);
            }
            const request = (
                url.protocol === 'https:' ? httpsRequest : httpRequest
            )(url, { method, headers });
            let response: IncomingMessage | undefined;

            // A socket timeout only counts idle time after connecting, so a
            // slow connection or a trickling answer would never end.
            const deadline = setTimeout(() => {
                const error = new Error('the request timed out');
                response?.destroy(error);
                request.destroy(error);
            }, timeoutMilliseconds);
            deadline.unref();
            const settled =
                <T>(finish: (value: T) => void) =>
                (value: T): void => {
                    clearTimeout(deadline);
                    finish(value);
                };

            request.on('socket', (socket) => socket.unref());
            request.on('error', settled(reject));
            request.on('response', (answer) => {
                response = answer;
                readResponse(answer, now).then(
                    settled(resolve),
                    settled(reject),
                );
            });
            request.end(body);
        });
}

async function readResponse(
    response: IncomingMessage,
    now: () => number,
): Promise<IngestResponse> {
    const chunks: Buffer[] = [];
    let length = 0;

    for await (const chunk of response) {
        const buffer = chunk as Buffer;
        if (length < MAX_RESPONSE_BYTES) {
            chunks.push(buffer);
        }
        length += buffer.length;
    }

    const status = response.statusCode ?? 0;
    const code = errorCode(Buffer.concat(chunks).toString('utf8'));
    const retryAfter = retryAfterMilliseconds(
        response.headers['retry-after'],
        now,
    );

    return {
        status,
        ...(code === undefined ? {} : { code }),
        ...(retryAfter === undefined
            ? {}
            : { retryAfterMilliseconds: retryAfter }),
    };
}

/** The `code` of an error body, `{ "message": "…", "code": "…" }`. */
function errorCode(text: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        const code = (parsed as { code?: unknown } | null)?.code;

        return typeof code === 'string' ? code : undefined;
    } catch {
        return undefined;
    }
}

/** `Retry-After` in seconds or as an HTTP date. */
export function retryAfterMilliseconds(
    header: string | undefined,
    now: () => number,
): number | undefined {
    if (header === undefined || header.trim() === '') {
        return undefined;
    }

    const value = header.trim();
    const milliseconds = /^\d+$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value) - now();

    return Number.isNaN(milliseconds)
        ? undefined
        : Math.min(Math.max(milliseconds, 0), MAX_RETRY_AFTER_MILLISECONDS);
}
