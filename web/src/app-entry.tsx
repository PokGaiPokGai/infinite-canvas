import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { isSharedStorageEnabled } from "@/lib/shared-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useThemeStore } from "@/stores/use-theme-store";

export async function mountApp() {
    if (isSharedStorageEnabled()) {
        const persisted = [useConfigStore.persist, usePromptSourceStore.persist, useThemeStore.persist, useCanvasStore.persist, useAssetStore.persist, usePluginStore.persist];
        await Promise.all(persisted.map((store) => store.rehydrate()));
        if (persisted.some((store) => !store.hasHydrated())) throw new Error("本机数据加载失败；原数据没有删除，请检查服务后重试。");
    }

    initAnalytics();

    document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
}
