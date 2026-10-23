import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "../web/node_modules/vite/dist/node/index.js";
import baseConfig from "../web/vite.config";

// Keep ComfyUI's existing loopback configuration; the browser uses the same origin as the canvas.
const proxy = {
    "/blender-link": {
        target: "http://127.0.0.1:3002", changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/blender-link/, "/blender"),
    },
    "/krita-link": {
        target: "http://127.0.0.1:3002", changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/krita-link/, "/krita"),
    },
    "/local-data": {
        target: "http://127.0.0.1:3002",
        changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/local-data/, "/storage"),
    },
    "/codex-image": {
        target: "http://127.0.0.1:3002",
        changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/codex-image/, ""),
    },
    "/comfy": {
        target: "http://127.0.0.1:8188",
        changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/comfy/, ""),
    },
};

export default mergeConfig(baseConfig, defineConfig({
    define: { "import.meta.env.VITE_LOCAL_SHARED_STORAGE": JSON.stringify("1") },
    root: fileURLToPath(new URL("../web", import.meta.url)),
    build: { outDir: resolve(fileURLToPath(new URL("../web", import.meta.url)), "dist") },
    server: { host: "127.0.0.1", port: 3000, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port: 3000, strictPort: true, proxy },
}));
