import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type ProxyOptions, type Plugin } from '../web/node_modules/vite/dist/node/index.js';
import baseConfig from '../web/vite.config';
import { buildDirectory, checkout, mainCheckout, runtimeEndpoint, sourceFingerprint, verifyBuild } from './runtime-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.INFINITE_CANVAS_PORT || 3000);
const origin = `http://127.0.0.1:${port}`;
const routes = { '/local-data': '/storage', '/krita-link': '/krita', '/blender-link': '/blender', '/codex-image': '' };
const proxy: Record<string, ProxyOptions> = Object.fromEntries(Object.entries(routes).map(([prefix, destination]) => [prefix, {
    target: 'http://127.0.0.1:3002', changeOrigin: true,
    rewrite: (path: string) => destination + path.slice(prefix.length),
    configure(server) {
        server.on('proxyReq', (outgoing, incoming) => {
            if (incoming.headers.origin === origin) outgoing.setHeader('Origin', 'http://127.0.0.1:3000');
        });
    },
} satisfies ProxyOptions]));
proxy['/comfy'] = { target: 'http://127.0.0.1:8188', changeOrigin: false, rewrite: path => path.replace(/^\/comfy/, '') };

function localRuntime(): Plugin {
    const connect = (server: any, mode: string) => {
        server.middlewares.use(runtimeEndpoint({ root, port, dataRoot: mainCheckout(root), mode,
            build: mode === 'production' ? verifyBuild(root) : null,
            stop: () => {
                if (typeof server.close === 'function') void server.close().then(() => process.exit(0));
                else { server.httpServer.close(() => process.exit(0)); server.httpServer.closeAllConnections?.(); }
            },
        }));
        server.middlewares.use((request: any, response: any, next: () => void) => {
            const path = request.url?.split('?')[0] || '';
            if (!Object.keys(proxy).some(prefix => path === prefix || path.startsWith(prefix + '/'))) return next();
            if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin) ||
                (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') || (request.method !== 'GET' && request.headers.origin !== origin)) {
                response.writeHead(403, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: '仅允许此入口的本机画布访问。' }));
                return;
            }
            next();
        });
    };
    return {
        name: 'canvas-local-runtime',
        configureServer: server => connect(server, 'development'),
        configurePreviewServer: server => connect(server, 'production'),
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: 'canvas-build.json', source: JSON.stringify({ mode: 'local-shared', head: checkout(root).head, fingerprint: sourceFingerprint(root), builtAt: new Date().toISOString() }, null, 2) });
        },
    };
}
export default mergeConfig(baseConfig, defineConfig({
    define: { 'import.meta.env.VITE_LOCAL_SHARED_STORAGE': JSON.stringify('1') },
    plugins: [localRuntime()],
    root: resolve(root, 'web'),
    build: { outDir: buildDirectory(root) },
    server: { host: '127.0.0.1', port, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port, strictPort: true, proxy },
}));
