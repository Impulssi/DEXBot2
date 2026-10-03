'use strict';

import net from 'node:net';
import { SOCKET_PATH } from './bot_supervisor.js';
import { getErrorCode } from '../utils/errors.js';
import type { UnknownRecord } from '../types.js';

interface ControlResponse {
    ok?: boolean;
    status?: unknown;
    error?: string;
    [key: string]: unknown;
}

function sendControlCommand(cmd: UnknownRecord): Promise<ControlResponse> {
    return new Promise<ControlResponse>((resolve, reject) => {
        const socket = net.createConnection(SOCKET_PATH);
        let buffer = '';
        let settled = false;

        const done = (err: Error | null, result?: ControlResponse) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            if (err) reject(err);
            else resolve(result ?? {});
        };

        const timeout = setTimeout(() => {
            done(new Error('Connection timed out. Is the supervisor running?'));
        }, 5000);

        socket.on('connect', () => {
            socket.write(JSON.stringify(cmd) + '\n');
        });

        socket.on('data', (data: Buffer) => {
            buffer += data.toString();
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx >= 0) {
                clearTimeout(timeout);
                try {
                    const resp = JSON.parse(buffer.slice(0, newlineIdx)) as ControlResponse;
                    if (resp.error) {
                        done(new Error(resp.error));
                    } else {
                        done(null, resp);
                    }
                } catch (err) {
                    done(err as Error);
                }
            }
        });

        socket.on('error', (err: Error) => {
            clearTimeout(timeout);
            const code = getErrorCode(err);
            if (code === 'ENOENT' || code === 'ECONNREFUSED') {
                done(new Error('No supervisor socket found. Start bots with: dexbot start --isolated'));
            } else {
                done(err);
            }
        });
    });
}

export { sendControlCommand }

