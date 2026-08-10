
import net from 'node:net';
import { SOCKET_PATH } from './bot_supervisor.js';
'use strict';


function sendControlCommand(cmd: any) {
    return new Promise((resolve: any, reject: any) => {
        const socket = net.createConnection(SOCKET_PATH);
        let buffer = '';
        let settled = false;

        const done = (err: Error | null, result?: any) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_: any) {}
            if (err) reject(err);
            else resolve(result);
        };

        const timeout = setTimeout(() => {
            done(new Error('Connection timed out. Is the supervisor running?'));
        }, 5000);

        socket.on('connect', () => {
            socket.write(JSON.stringify(cmd) + '\n');
        });

        socket.on('data', (data: any) => {
            buffer += data.toString();
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx >= 0) {
                clearTimeout(timeout);
                try {
                    const resp = JSON.parse(buffer.slice(0, newlineIdx));
                    if (resp.error) {
                        done(new Error(resp.error));
                    } else {
                        done(null, resp);
                    }
                } catch (err: any) {
                    done(err);
                }
            }
        });

        socket.on('error', (err: any) => {
            clearTimeout(timeout);
            if ((err as any).code === 'ENOENT' || (err as any).code === 'ECONNREFUSED') {
                done(new Error('No supervisor socket found. Start bots with: dexbot start --isolated'));
            } else {
                done(err);
            }
        });
    });
}

export { sendControlCommand }

