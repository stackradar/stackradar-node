/**
 * Reporting after start-up: the Runtime Report at
 * every heartbeat, the package list when the server asks for it, and what
 * each answer means. Runtime-independent: sending is passed in.
 */

import type { Package } from './inventory.js';
import type { RuntimeReportBody } from './report.js';

/** This reporter's heartbeat; the server sends no intervals. */
export const HEARTBEAT_MILLISECONDS = 10 * 60 * 1000;

/** The largest body the server accepts. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface IngestRequest {
    method: 'POST' | 'PUT';
    path: string;
    body: string;
}

export interface IngestResponse {
    status: number;
    /** The `code` of an error body, such as `unknown_inventory`. */
    code?: string;
    retryAfterMilliseconds?: number;
}

/** Sends one request; rejects on a network error or timeout. */
export type Send = (request: IngestRequest) => Promise<IngestResponse>;

export interface ReportingInputs {
    body: RuntimeReportBody;
    /** The list behind `body.packages.inventory_hash`. */
    packages: Package[] | null;
    send: Send;
    log: (message: string) => void;
    now?: () => number;
}

export interface Reporting {
    /** One heartbeat. Never throws; overlapping calls are skipped. */
    tick(): Promise<void>;
    readonly stopped: boolean;
}

export function createReporting({
    body,
    packages,
    send,
    log,
    now = Date.now,
}: ReportingInputs): Reporting {
    const report = JSON.stringify(body);
    let stopped = false;
    let busy = false;
    let waitUntil = 0;

    /** What each answer means. */
    function handle(response: IngestResponse, what: string): void {
        const { status, code } = response;
        const named = code === undefined ? `${status}` : `${status} ${code}`;

        if (status >= 200 && status < 300) {
            log(`${what} accepted`);
        } else if (status === 401 || status === 403 || status === 410) {
            stopped = true;
            log(
                `${what} answered ${named}; reporting stopped for this process`,
            );
        } else if (status === 429) {
            waitUntil = now() + (response.retryAfterMilliseconds ?? 0);
            log(`${what} rate limited; waiting before the next heartbeat`);
        } else {
            // 413, 422, 5xx: try again at the next heartbeat.
            log(
                `${what} answered ${named}; trying again at the next heartbeat`,
            );
        }
    }

    async function upload(): Promise<void> {
        const hash = body.packages.inventory_hash;
        if (packages === null || hash === null) {
            log('the server asked for a package list, but none was collected');
            return;
        }

        const list = JSON.stringify({
            protocol_version: 1,
            ecosystem: body.packages.ecosystem,
            packages,
        });
        if (Buffer.byteLength(list, 'utf8') > MAX_BODY_BYTES) {
            log('the package list is over 1 MB; not uploaded');
            return;
        }

        log(`uploading the package list (${packages.length} packages)`);
        handle(
            await send({
                method: 'PUT',
                path: `/v1/package-inventories/${hash}`,
                body: list,
            }),
            'package list',
        );
    }

    return {
        get stopped() {
            return stopped;
        },
        async tick(): Promise<void> {
            if (stopped || busy || now() < waitUntil) {
                return;
            }
            busy = true;

            try {
                const response = await send({
                    method: 'POST',
                    path: '/v1/runtime-reports',
                    body: report,
                });

                if (
                    response.status === 409 &&
                    response.code === 'unknown_inventory'
                ) {
                    await upload();
                } else {
                    handle(response, 'report');
                }
            } catch (error) {
                log(
                    `sending failed (${error instanceof Error ? error.message : String(error)}); trying again at the next heartbeat`,
                );
            } finally {
                busy = false;
            }
        },
    };
}
