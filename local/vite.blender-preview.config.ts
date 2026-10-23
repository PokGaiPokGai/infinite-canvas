import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type ProxyOptions } from "../web/node_modules/vite/dist/node/index.js";
import localConfig from "./vite.config";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const origin = "http://127.0.0.1:3034";
const routes = { "/local-data": "/storage", "/krita-link": "/krita", "/codex-image": "" };
const sharedProxy = Object.fromEntries(Object.entries(routes).map(([prefix, destination]) => [prefix, {
    target: "http://127.0.0.1:3002", changeOrigin: true,
    rewrite: (path: string) => destination + path.slice(prefix.length),
    configure(server) {
        server.on("proxyReq", (outgoing, incoming) => {
            if (incoming.headers.origin === origin) outgoing.setHeader("Origin", "http://127.0.0.1:3000");
        });
    },
} satisfies ProxyOptions]));

export default mergeConfig(localConfig, defineConfig({
    root: resolve(appRoot, "web"),
    cacheDir: resolve(appRoot, ".local/blender-preview/vite-cache"),
    define: { "import.meta.env.VITE_LOCAL_SHARED_STORAGE": JSON.stringify("1") },
    plugins: [{
        name: "blender-preview-services",
        transformIndexHtml: html => html.replace(/<title>.*?<\/title>/, "<title>无限画布 · Blender v2 分支预览</title>"),
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const path = request.url?.split("?")[0] || "";
                if (!Object.keys(routes).some(prefix => path === prefix || path.startsWith(prefix + "/"))) return next();
                const source = request.headers.origin;
                const site = request.headers["sec-fetch-site"];
                if (request.headers.host !== "127.0.0.1:3034" || (source && source !== origin) ||
                    (site && site !== "same-origin") || (request.method !== "GET" && source !== origin)) {
                    response.writeHead(403, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({ error: "仅允许此分支的本机画布访问。" }));
                    return;
                }
                next();
            });
        },
    }],
    server: {
        host: "127.0.0.1", port: 3034, strictPort: true,
        fs: { allow: [appRoot, realpathSync(resolve(appRoot, "web/node_modules"))] },
        proxy: {
            ...sharedProxy,
            "/blender-link": { target: "http://127.0.0.1:3036", changeOrigin: false, rewrite: path => path.replace(/^\/blender-link/, "/blender") },
            "/blender-preview-health": { target: "http://127.0.0.1:3036", rewrite: () => "/health" },
        },
    },
}));
