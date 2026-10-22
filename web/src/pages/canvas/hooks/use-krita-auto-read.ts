import { useEffect, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { KRITA_LINK } from "@/lib/canvas/krita-link";
import { beginKritaRead, waitForKritaRead } from "@/lib/canvas/krita-read-lock";
import { getSharedStorageStatus, subscribeSharedStorage } from "@/lib/shared-storage";
import { checkKritaSnapshot, claimKritaAuto, getKritaImage, getKritaStatus, heartbeatKritaAuto, releaseKritaAuto, waitKritaActivity } from "@/services/api/krita-link";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import type { CanvasNodeData } from "@/types/canvas";
import type { KritaLinkMetadata, KritaStatus } from "@/types/krita-link";

const autoLink = (node: CanvasNodeData | null | undefined): KritaLinkMetadata | null => {
    const link = node?.metadata?.krita;
    return node?.type === KRITA_LINK && link?.kind === "link" && link.mode === "read" && link.autoRead && link.documentId ? link : null;
};

type Params = {
    projectId: string;
    projectLoaded: boolean;
    bindings: string;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    retryMs: number;
};

export function useKritaAutoRead({ projectId, projectLoaded, bindings, nodesRef, setNodes, retryMs }: Params) {
    const storageStatus = useSyncExternalStore(subscribeSharedStorage, getSharedStorageStatus);
    const storagePaused = storageStatus.remoteChanged || !!storageStatus.error;
    useEffect(() => {
        if (!projectLoaded || !bindings || storagePaused) return;
        const controller = new AbortController();
        const { signal } = controller;
        const clientId = crypto.randomUUID();
        let leaseId: string | undefined;
        let captureController: AbortController | undefined;
        let watchController: AbortController | undefined;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let heartbeatPending = false;
        let capturePending = true;
        const storageReady = () => {
            const status = getSharedStorageStatus();
            return !status.remoteChanged && !status.error;
        };
        const loseLease = (currentLease: string) => {
            if (leaseId !== currentLease) return;
            leaseId = undefined;
            capturePending = true;
            captureController?.abort();
            watchController?.abort();
        };
        const heartbeatTimer = setInterval(() => {
            const currentLease = leaseId;
            if (!currentLease || heartbeatPending || signal.aborted) return;
            heartbeatPending = true;
            void heartbeatKritaAuto(projectId, clientId, currentLease, signal)
                .then(({ leader }) => { if (!leader) loseLease(currentLease); })
                .catch(() => loseLease(currentLease))
                .finally(() => { heartbeatPending = false; });
        }, 30_000);
        const waitRetry = () => new Promise<void>((resolve) => {
            const finish = () => { if (retryTimer) clearTimeout(retryTimer); signal.removeEventListener("abort", finish); resolve(); };
            retryTimer = setTimeout(finish, retryMs);
            signal.addEventListener("abort", finish, { once: true });
        });
        const patchError = (nodeId: string, documentId: string, layerId: string | undefined, message?: string) => {
            if (signal.aborted || !storageReady()) return;
            setNodes((previous) => {
                if (!storageReady()) return previous;
                let changed = false;
                const next = previous.map((node) => {
                    const link = autoLink(node);
                    if (node.id !== nodeId || link?.documentId !== documentId || link.layerId !== layerId) return node;
                    const old = node.metadata?.errorDetails;
                    if (message ? old === message : !old?.startsWith("Auto 读取：")) return node;
                    changed = true;
                    return { ...node, metadata: { ...node.metadata, errorDetails: message } };
                });
                return changed ? next : previous;
            });
        };
        const active = (captureLease: string, nodeId: string, documentId: string, layerId: string | undefined, snapshotId: string | undefined) => {
            const current = nodesRef.current.find((node) => node.id === nodeId);
            const link = autoLink(current);
            return !signal.aborted && storageReady() && leaseId === captureLease && link?.documentId === documentId && link.layerId === layerId && link.snapshot?.id === snapshotId;
        };
        const capture = async (status: KritaStatus, captureLease: string, captureSignal: AbortSignal) => {
            for (const node of nodesRef.current.filter((item) => autoLink(item))) {
                if (signal.aborted || captureSignal.aborted || !storageReady() || leaseId !== captureLease) return;
                const link = autoLink(node)!;
                const documentId = link.documentId!;
                const layerId = link.layerId;
                const document = status.documents.find((item) => item.id === documentId);
                if (!document) { patchError(node.id, documentId, layerId); continue; }
                if (layerId && !document.layers.some((item) => item.id === layerId)) { patchError(node.id, documentId, layerId, "Auto 读取：原绑定图层暂不可用，请重新选择。"); continue; }
                const oldSnapshot = link.snapshot;
                const expectedHash = oldSnapshot && oldSnapshot.sessionId === status.sessionId && oldSnapshot.documentId === documentId && oldSnapshot.layerId === layerId ? oldSnapshot.pixelSha256 : undefined;
                let finishRead = beginKritaRead(projectId, node.id);
                if (!finishRead) {
                    await waitForKritaRead(projectId, node.id, captureSignal);
                    if (!active(captureLease, node.id, documentId, layerId, oldSnapshot?.id)) continue;
                    finishRead = beginKritaRead(projectId, node.id);
                    if (!finishRead) continue;
                }
                try {
                    const result = await checkKritaSnapshot(documentId, layerId, expectedHash, captureSignal);
                    if (signal.aborted || captureSignal.aborted) return;
                    if (result.sessionId !== status.sessionId || result.documentId !== documentId || result.layerId !== layerId) throw new Error("Krita 会话或绑定文档已变化，请重新绑定。");
                    if ("unchanged" in result) { patchError(node.id, documentId, layerId); continue; }
                    if (!active(captureLease, node.id, documentId, layerId, oldSnapshot?.id)) continue;
                    const image = await uploadImage(await getKritaImage(result.imageUrl, captureSignal), { signal: captureSignal });
                    if (!active(captureLease, node.id, documentId, layerId, oldSnapshot?.id)) {
                        if (image.storageKey) await deleteStoredImages([image.storageKey]);
                        continue;
                    }
                    try {
                        flushSync(() => setNodes((previous) => {
                            let changed = false;
                            const next = previous.map((item) => {
                                const current = autoLink(item);
                                if (!storageReady() || leaseId !== captureLease || item.id !== node.id || current?.documentId !== documentId || current.layerId !== layerId || current.snapshot?.id !== oldSnapshot?.id) return item;
                                changed = true;
                                return { ...item, metadata: { ...item.metadata, ...imageMetadata(image), errorDetails: undefined, krita: { ...current, snapshot: result, lastReadKind: "auto" as const } } };
                            });
                            return changed ? next : previous;
                        }));
                    } finally {
                        if (image.storageKey && !nodesRef.current.some((item) => item.metadata?.storageKey === image.storageKey)) {
                            await deleteStoredImages([image.storageKey]);
                        }
                    }
                } catch (error) {
                    if (signal.aborted || captureSignal.aborted || leaseId !== captureLease) return;
                    patchError(node.id, documentId, layerId, `Auto 读取：${error instanceof Error ? error.message : "Krita 暂时无法读取。"}`);
                } finally { finishRead(); }
            }
        };
        const run = async () => {
            let revision = 0;
            let sessionId = "";
            while (!signal.aborted) {
                try {
                    if (!storageReady()) return;
                    const claim = await claimKritaAuto(projectId, clientId);
                    if (signal.aborted) {
                        if (claim.leader && claim.leaseId) void releaseKritaAuto(projectId, clientId, claim.leaseId).catch(() => undefined);
                        return;
                    }
                    if (!claim.leader || !claim.leaseId) { leaseId = undefined; capturePending = true; await waitRetry(); continue; }
                    leaseId = claim.leaseId;
                    if (capturePending) {
                        const status = await getKritaStatus(signal);
                        if (!status.connected || !status.sessionId) throw new Error(status.error || "Krita 未连接，请打开 Krita 后重试。");
                        if (sessionId !== status.sessionId) { sessionId = status.sessionId; revision = status.activityRevision ?? 0; }
                        const captureRequest = new AbortController();
                        captureController = captureRequest;
                        try { await capture(status, claim.leaseId, captureRequest.signal); }
                        finally { if (captureController === captureRequest) captureController = undefined; }
                        if (leaseId !== claim.leaseId) { capturePending = true; await waitRetry(); continue; }
                        capturePending = false;
                    }
                    if (signal.aborted) return;
                    if (!storageReady()) return;
                    const watch = new AbortController();
                    watchController = watch;
                    let activity;
                    try { activity = await waitKritaActivity(revision, projectId, clientId, watch.signal); }
                    finally { if (watchController === watch) watchController = undefined; }
                    if ("standby" in activity) { leaseId = undefined; capturePending = true; await waitRetry(); continue; }
                    if (activity.sessionId !== sessionId) { sessionId = activity.sessionId; revision = 0; capturePending = true; continue; }
                    revision = activity.revision;
                    if (activity.changed) capturePending = true;
                } catch (error) {
                    if (signal.aborted) return;
                    if (!leaseId) { capturePending = true; await waitRetry(); continue; }
                    const message = `Auto 读取：${error instanceof Error ? error.message : "Krita 连接暂时不可用。"}`;
                    nodesRef.current.forEach((node) => {
                        const link = autoLink(node);
                        if (link) patchError(node.id, link.documentId!, link.layerId, message);
                    });
                    capturePending = true;
                    await waitRetry();
                }
            }
        };
        void run();
        return () => { controller.abort(); captureController?.abort(); watchController?.abort(); clearInterval(heartbeatTimer); if (retryTimer) clearTimeout(retryTimer); if (leaseId) void releaseKritaAuto(projectId, clientId, leaseId).catch(() => undefined); };
    }, [bindings, nodesRef, projectId, projectLoaded, retryMs, setNodes, storagePaused]);
}
