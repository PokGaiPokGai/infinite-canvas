import type { StateStorage } from "zustand/middleware";
import { createAppStorage, isSharedStorageEnabled } from "@/lib/shared-storage";

const store = createAppStorage({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await store.getItem<string>(name)) || null;
        } catch (error) {
            if (isSharedStorageEnabled()) throw error;
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await store.setItem(name, value);
        } catch (error) {
            if (isSharedStorageEnabled()) throw error;
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await store.removeItem(name);
        } catch (error) {
            if (isSharedStorageEnabled()) throw error;
            window.localStorage.removeItem(name);
        }
    },
};
