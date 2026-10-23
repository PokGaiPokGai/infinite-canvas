import { useLayoutEffect, useRef, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { createMaskAutoUpdater } from "@/lib/canvas/mask-auto-updater";
import { maskAutoJobs } from "@/lib/canvas/mask-auto-jobs";
import { processMask } from "@/lib/canvas/image-mask";
import { resolveComparisonNodes } from "@/lib/canvas/image-compare";
import { resolveVersionStacks } from "@/lib/canvas/version-stack";
import { getSharedStorageStatus, subscribeSharedStorage } from "@/lib/shared-storage";
import { deleteStoredImages } from "@/services/image-storage";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type Params = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

export function useMaskAutoUpdate({ projectId, projectLoaded, nodes, connectionsRef, setNodes }: Params) {
    const storage = useSyncExternalStore(subscribeSharedStorage, getSharedStorageStatus);
    const paused = !projectLoaded || storage.remoteChanged || !!storage.error;
    const updater = useRef<ReturnType<typeof createMaskAutoUpdater> | null>(null);
    useLayoutEffect(() => {
        const current = createMaskAutoUpdater({
            process: (job, signal) => processMask(job.type, job.settings, job.inputs, signal),
            publish: (job, patch) => {
                let accepted = false;
                flushSync(() => setNodes(previous => {
                    const status = getSharedStorageStatus();
                    if (updater.current !== current || status.remoteChanged || status.error) return previous;
                    // Recheck against the actual queued React state, not the run's snapshot.
                    const resolved = resolveComparisonNodes(resolveVersionStacks(previous), connectionsRef.current);
                    if (resolved.find(node => node.id === job.id)?.metadata?.processInputKey !== job.key) return previous;
                    accepted = true;
                    return previous.map(node => node.id === job.id ? { ...node, metadata: { ...node.metadata, ...patch } } : node);
                }));
                return accepted;
            },
            discard: async patch => { if (patch.storageKey) await deleteStoredImages([patch.storageKey]); },
        });
        updater.current = current;
        return () => { updater.current = null; current.dispose(); };
    }, [projectId, connectionsRef, setNodes]);

    useLayoutEffect(() => {
        updater.current?.update(paused ? [] : maskAutoJobs(nodes));
    }, [nodes, paused, projectId]);
}
