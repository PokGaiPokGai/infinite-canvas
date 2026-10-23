import { defineConfig, mergeConfig, type ProxyOptions } from "../web/node_modules/vite/dist/node/index.js";
import localConfig from "./vite.config";

const origin = "http://127.0.0.1:3060";
const bridgeOrigin = "http://127.0.0.1:3000";
const routes = { "/local-data": "/storage", "/krita-link": "/krita", "/blender-link": "/blender", "/codex-image": "" };
const proxy = Object.fromEntries(Object.entries(routes).map(([prefix, destination]) => [prefix, {
    target: "http://127.0.0.1:3002",
    changeOrigin: true,
    rewrite: (path: string) => destination + path.slice(prefix.length),
    configure(server) {
        server.on("proxyReq", (outgoing, incoming) => {
            // Only translate this branch's validated origin. Keep upstream access checks intact.
            if (incoming.headers.origin === origin) outgoing.setHeader("Origin", bridgeOrigin);
        });
    },
} satisfies ProxyOptions]));

export default mergeConfig(localConfig, defineConfig({
    plugins: [{
        name: "production-workflows-local-services",
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const path = request.url?.split("?")[0] || "";
                if (path === "/__production-workflows") {
                    response.setHeader("Content-Type", "application/json");
                    response.end(JSON.stringify({ branch: "production-workflows", sharedStorage: true }));
                    return;
                }
                if (!Object.keys(routes).some((prefix) => path === prefix || path.startsWith(prefix + "/"))) return next();
                const source = request.headers.origin;
                const site = request.headers["sec-fetch-site"];
                if (request.headers.host !== "127.0.0.1:3060" || (source && source !== origin) ||
                    (site && site !== "same-origin") || (request.method !== "GET" && source !== origin)) {
                    response.writeHead(403, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({ error: "仅允许此分支的本机画布访问。" }));
                    return;
                }
                next();
            });
        },
    }],
    server: { host: "127.0.0.1", port: 3060, strictPort: true, proxy },
}));
