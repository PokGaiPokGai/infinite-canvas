import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "../web/node_modules/vite/dist/node/index.js";
import baseConfig from "../web/vite.config";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
export default mergeConfig(baseConfig, defineConfig({
    root: resolve(appRoot, "web"),
    cacheDir: resolve(appRoot, ".local/blender-preview/vite-cache"),
    define: { "import.meta.env.VITE_LOCAL_SHARED_STORAGE": JSON.stringify("1") },
    plugins: [{ name: "blender-preview-title", transformIndexHtml: html => html.replace(/<title>.*?<\/title>/, "<title>无限画布 · Blender 分支预览</title>") }],
    server: {
        host: "127.0.0.1", port: 3030, strictPort: true,
        fs: { allow: [appRoot, realpathSync(resolve(appRoot, "web/node_modules"))] },
        proxy: {
            "/blender-link": { target: "http://127.0.0.1:3032", changeOrigin: false, rewrite: path => path.replace(/^\/blender-link/, "/blender") },
            "/local-data": { target: "http://127.0.0.1:3032", changeOrigin: false, rewrite: path => path.replace(/^\/local-data/, "/storage") },
            "/blender-preview-health": { target: "http://127.0.0.1:3032", rewrite: () => "/health" },
        },
    },
}));
