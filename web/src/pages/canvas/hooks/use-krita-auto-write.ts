import { useEffect, useRef, useSyncExternalStore } from "react";
import { sendKritaWrite } from "@/components/canvas/krita-link-nodes";
import { canvasThemes } from "@/lib/canvas-theme";
import { getKritaWriteDelivery, isAutoReadDelivery, type KritaWriteDelivery } from "@/lib/canvas/krita-write-delivery";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { getSharedStorageStatus, subscribeSharedStorage } from "@/lib/shared-storage";
import { getKritaStatus } from "@/services/api/krita-link";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginHost } from "@/types/canvas-plugin";
import type { KritaLinkMetadata } from "@/types/krita-link";

type Delivery = { nodeId: string; image: KritaWriteDelivery; blockedIntent?: string };
type Tracking = { projectId: string; connections: Set<string>; last: Map<string, string>; modes: Map<string, string>; seen: Set<string> };
const writeIntent = (link: KritaLinkMetadata) => JSON.stringify([link.documentId, link.writeTargetMode, link.insertAboveLayerId, link.overwriteLayerId, link.newLayerPolicy, link.managedLayerId, link.fitToCanvas]);

async function deliveryUuid(projectId: string, nodeId: string, key: string) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([projectId, nodeId, key]))));
    digest[6] = (digest[6] & 15) | 80;
    digest[8] = (digest[8] & 63) | 128;
    const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useKritaAutoWrite({ projectId, projectLoaded, nodes, connections, host, theme }: {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    host: CanvasPluginHost;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
}) {
    const storage = useSyncExternalStore(subscribeSharedStorage, getSharedStorageStatus);
    const tracking = useRef<Tracking | null>(null);
    const queue = useRef<Delivery[]>([]);
    const writing = useRef(false);

    useEffect(() => () => { tracking.current = null; queue.current = []; }, [projectId]);

    useEffect(() => {
        if (!projectLoaded) { tracking.current = null; queue.current = []; return; }
        const current = tracking.current;
        if (!current || current.projectId !== projectId) {
            const last = new Map<string, string>();
            const modes = new Map<string, string>();
            const seen = new Set<string>();
            nodes.forEach((node) => {
                if (node.metadata?.krita?.kind === "link") modes.set(node.id, node.metadata.krita.mode);
                const delivery = getKritaWriteDelivery(node, nodes, connections);
                if (delivery) { last.set(node.id, delivery.key); seen.add(`${node.id}:${delivery.key}`); }
            });
            tracking.current = { projectId, connections: new Set(connections.map((item) => item.id)), last, modes, seen };
            return;
        }
        const addedConnections = new Set(connections.filter((item) => !current.connections.has(item.id)).map((item) => item.id));
        current.connections = new Set(connections.map((item) => item.id));
        nodes.forEach((node) => {
            const mode = node.metadata?.krita?.kind === "link" ? node.metadata.krita.mode : undefined;
            const previousMode = current.modes.get(node.id);
            if (mode) current.modes.set(node.id, mode);
            const delivery = getKritaWriteDelivery(node, nodes, connections);
            if (!delivery) return;
            if (current.last.get(node.id) === delivery.key) return;
            current.last.set(node.id, delivery.key);
            const seenKey = `${node.id}:${delivery.key}`;
            if (current.seen.has(seenKey)) return;
            current.seen.add(seenKey);
            if (previousMode && previousMode !== "write") return;
            if (isAutoReadDelivery(delivery) && !addedConnections.has(delivery.connectionId)) return;
            if (!node.metadata?.krita || node.metadata.krita.kind !== "link" || !node.metadata.krita.documentId) queue.current = queue.current.filter((item) => item.nodeId !== node.id);
            queue.current.push({ nodeId: node.id, image: delivery });
        });
    }, [connections, nodes, projectId, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || storage.error || storage.remoteChanged || writing.current || !queue.current.length) return;
        const run = async () => {
            writing.current = true;
            try {
                while (queue.current.length && tracking.current?.projectId === projectId && !getSharedStorageStatus().error && !getSharedStorageStatus().remoteChanged) {
                    queue.current = queue.current.filter((item) => {
                        const link = host.getNode(item.nodeId)?.metadata?.krita;
                        return link?.kind === "link" && link.mode === "write";
                    });
                    const delivery = queue.current.find((item) => {
                        const link = host.getNode(item.nodeId)?.metadata?.krita;
                        return link?.kind === "link" && !!link.documentId && (link.writeTargetMode === "overwrite" ? !!link.overwriteLayerId : !!link.insertAboveLayerId || link.newLayerPolicy !== "always-new" && !!link.managedLayerId) && (!link.commandId || !!link.returnedLayerId) && item.blockedIntent !== writeIntent(link);
                    });
                    if (!delivery) break;
                    const remove = () => { queue.current = queue.current.filter((item) => item !== delivery); };
                    const node = host.getNode(delivery.nodeId)!;
                    const link = node.metadata?.krita;
                    if (link?.kind !== "link" || link.mode !== "write") { remove(); continue; }
                    if (getKritaWriteDelivery(node, host.getNodes(), host.getConnections())?.key !== delivery.image.key) { remove(); continue; }
                    const deliveryId = await deliveryUuid(projectId, node.id, delivery.image.key);
                    if (link.sourceDeliveryKey === delivery.image.key && !!link.commandId || link.writeHistory?.some((record) => record.deliveryId === deliveryId) || link.deliveryId === deliveryId && !!link.returnedLayerId) { remove(); continue; }
                    if (tracking.current?.projectId !== projectId || getSharedStorageStatus().error || getSharedStorageStatus().remoteChanged) break;
                    const ctx = buildNodeContext(host, node, theme, 1);
                    try {
                        const status = await getKritaStatus();
                        if (tracking.current?.projectId !== projectId || getSharedStorageStatus().error || getSharedStorageStatus().remoteChanged) break;
                        await sendKritaWrite(ctx, link, status, { node: delivery.image.sourceNode, storageKey: delivery.image.storageKey, url: delivery.image.url }, deliveryId, delivery.image.key);
                        remove();
                        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    } catch (error) {
                        ctx.updateMetadata({ errorDetails: `写回失败：${error instanceof Error ? error.message : "Krita 暂时无法写回。"} 请在节点控制面板检查并重试。` });
                        const latest = host.getNode(delivery.nodeId);
                        const current = latest?.metadata?.krita;
                        const saved = await ctx.storage.get<KritaLinkMetadata>(`write:${projectId}:${delivery.nodeId}`).catch(() => null);
                        if (!latest || current?.kind !== "link" || current.mode !== "write" || current.sourceDeliveryKey === delivery.image.key && !!current.commandId || getKritaWriteDelivery(latest, host.getNodes(), host.getConnections())?.key !== delivery.image.key || saved?.deliveryId === deliveryId && !!saved.commandId && !saved.returnedLayerId) remove();
                        else delivery.blockedIntent = writeIntent(link);
                    }
                }
            } finally { writing.current = false; }
        };
        void run();
    }, [connections, host, nodes, projectId, projectLoaded, storage.error, storage.remoteChanged, theme]);
}
