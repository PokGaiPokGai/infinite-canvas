import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Read this checkout on each page load, including after a branch switch.
function worktreePageTitle(): Plugin {
    return {
        name: "worktree-page-title",
        apply: "serve",
        transformIndexHtml(html, context) {
            let branch = "未知分支";
            try {
                const git = (...args: string[]) => execFileSync("git", ["-C", webDir, ...args], {
                    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
                }).trim();
                branch = git("rev-parse", "--abbrev-ref", "HEAD");
                if (branch === "HEAD") branch = `detached@${git("rev-parse", "--short", "HEAD")}`;
            } catch { /* Keep the page identifiable when Git is unavailable. */ }
            const label = branch.replace(/^codex\//, "");
            const address = context.server?.httpServer?.address();
            const port = address && typeof address === "object" ? address.port : undefined;
            const prefix = [label, port].filter(Boolean).join(" · ");
            const escaped = prefix.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            return {
                html: html.replace(/<title>(.*?)<\/title>/, (_, title) => `<title>${escaped} | ${title}</title>`),
                tags: [{ tag: "meta", attrs: { name: "infinite-canvas:dev-branch", content: label }, injectTo: "head" }],
            };
        },
    };
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), worktreePageTitle()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
