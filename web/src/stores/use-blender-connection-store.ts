import { create } from "zustand";
import { getBlenderConnection, setBlenderConnection } from "@/services/api/blender-link";

let loading: Promise<void> | null = null;
export const useBlenderConnectionStore = create<{
    port: number | null;
    revision: number;
    saving: boolean;
    load: () => Promise<void>;
    save: (port: number) => Promise<void>;
}>((set, get) => ({
    port: null, revision: 0, saving: false,
    load: () => {
        if (get().port !== null) return Promise.resolve();
        return loading ??= getBlenderConnection().then(connection => { if (get().port === null && !get().saving) set({ port: connection.port }); }).finally(() => { loading = null; });
    },
    save: async (port) => {
        if (get().saving) return;
        set({ saving: true });
        try {
            const connection = await setBlenderConnection(port);
            set(state => ({ port: connection.port, revision: state.revision + 1 }));
        } finally { set({ saving: false }); }
    },
}));
