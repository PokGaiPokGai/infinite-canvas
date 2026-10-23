// Development preview for this worktree. Existing canvas data stays in its own database.
import { createServer as createHttpServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from '../web/node_modules/vite/dist/node/index.js';
import { createSharedStorage } from './shared-storage.mjs';
import { createBlenderBridge } from './blender-bridge.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canvasOrigin = 'http://127.0.0.1:3030';
const shared = createSharedStorage({ dataDirectory: join(appRoot, '.local', 'blender-preview', 'app-data'), canvasOrigin });
const blender = createBlenderBridge({ appRoot, canvasOrigin });
let ready = false;
const server = createHttpServer(async (request, response) => {
    try {
        if (!['127.0.0.1:3030', '127.0.0.1:3032'].includes(request.headers.host) ||
            (request.headers.origin && request.headers.origin !== canvasOrigin) ||
            (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
            response.writeHead(403); response.end(); return;
        }
        const path = new URL(request.url, 'http://127.0.0.1:3032').pathname;
        if (path === '/health' && request.method === 'GET') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ service: 'infinite-canvas-blender-preview', appRoot, ready, url: canvasOrigin }));
        } else if (!(await shared.handle(request, response, path)) && !(await blender.handle(request, response, path))) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: '此预览提供 Blender Link 与独立测试存储。' }));
        }
    } catch (error) {
        console.error(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
    }
});
let vite;
try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(3032, '127.0.0.1', accept); });
    vite = await createViteServer({ configFile: join(appRoot, 'local', 'vite.blender-preview.config.ts') });
    await vite.listen();
    ready = true;
    console.log(`Blender branch preview: ${canvasOrigin}/canvas`);
} catch (error) {
    console.error(error);
    await vite?.close();
    server.close();
    process.exitCode = 1;
}
