import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, Brush, Settings2, X } from "lucide-react";
import { getNodeDefinition, registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { hasKritaWriteOutput } from "@/lib/canvas/canvas-input-role";
import { getKritaWriteDelivery } from "@/lib/canvas/krita-write-delivery";
import { beginKritaRead } from "@/lib/canvas/krita-read-lock";
import { isConnectionOperational } from "@/lib/canvas/canvas-connection-state";
import { KRITA_LINK, KRITA_PRESET, KRITA_SOURCE, asPng, followKritaGeneration, isKritaNodeBusy, patchKritaPreset, stopKritaWaiting, submitConfiguredKritaGeneration, submitKritaGeneration } from "@/lib/canvas/krita-link";
import { createKritaSnapshot, getKritaImage, getKritaPresets, getKritaStatus, listKritaGenerations, returnCanvasImage, returnKritaImage, type KritaWriteTarget } from "@/services/api/krita-link";
import { deleteStoredImages, imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeToolbarItem } from "@/types/canvas-plugin";
import type { KritaGeneration, KritaGenerationParams, KritaLayer, KritaLinkMetadata, KritaPresetCatalog, KritaPresetMetadata, KritaSourceMetadata, KritaStatus } from "@/types/krita-link";

const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const fieldClass = "w-full rounded border px-2.5 py-2 text-sm outline-none focus:ring-1";
const textOf = (error: unknown) => error instanceof Error ? error.message : "本机绘画连接暂时不可用。";
const controlStyle = (ctx: CanvasNodeContext): CSSProperties => ({ background: ctx.theme.node.panel, color: ctx.theme.node.text, borderColor: ctx.theme.node.stroke });
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const jobLabel = { queued: "等待中", running: "生成中", succeeded: "已完成", failed: "失败" };

export const isKritaResultNode = (node: CanvasNodeData) => node.type === CanvasNodeType.Image && node.metadata?.krita?.kind === "result";
export const isKritaDockedNode = (node: CanvasNodeData) => node.type === KRITA_SOURCE || node.type === KRITA_PRESET || isKritaResultNode(node);
const isKritaReadNode = (node: CanvasNodeData) => node.type === KRITA_SOURCE || (node.type === KRITA_LINK && node.metadata?.krita?.kind === "link" && node.metadata.krita.mode === "read");
const readSnapshot = (node: CanvasNodeData) => {
    const metadata = node.metadata?.krita;
    return metadata?.kind === "source" || (metadata?.kind === "link" && metadata.mode === "read") ? metadata.snapshot : undefined;
};

function PanelFrame({ ctx, title, onClose, children }: { ctx: CanvasNodeContext; title: string; onClose: () => void; children: ReactNode }) {
    return <div data-canvas-no-zoom className="flex min-h-0 max-h-[calc(100vh-24px)] flex-col text-sm" style={{ color: ctx.theme.node.text }}>
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: ctx.theme.node.stroke }}><div className="min-w-0"><div className="font-medium">{title}</div><div className="mt-0.5 truncate text-xs opacity-60">{ctx.node.title}</div></div><button type="button" className={buttonClass} aria-label="关闭控制面板" onClick={onClose}><X className="size-4" /></button></header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
    </div>;
}

function writeInputs(ctx: CanvasNodeContext) {
    const connections = ctx.getConnections().filter((connection) => connection.toNodeId === ctx.node.id && isConnectionOperational(connection, ctx.getNode(connection.fromNodeId) || undefined, ctx.node));
    const images = connections.flatMap((connection) => {
        const node = ctx.getNode(connection.fromNodeId);
        if (!node) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const configImage = node.type === CanvasNodeType.Config && (!node.metadata?.generationMode || node.metadata.generationMode === "image");
        if (node.type !== CanvasNodeType.Image && !configImage && resource?.kind !== "image") return [];
        const url = node.metadata?.content || (resource?.kind === "image" ? resource.url : undefined);
        const storageKey = node.metadata?.storageKey;
        return [{ node, url, storageKey }];
    });
    return { count: connections.length, images };
}

const writingNodes = new Set<string>();
const submittingNodes = new Set<string>();
type WriteInput = ReturnType<typeof writeInputs>["images"][number] | null;
const writeTarget = (link: KritaLinkMetadata): KritaWriteTarget => link.writeTargetMode === "overwrite"
    ? { writeMode: "replace", replaceLayerId: link.overwriteLayerId || "" }
    : link.newLayerPolicy !== "always-new" && link.managedLayerId
        ? { writeMode: "replace", replaceLayerId: link.managedLayerId }
        : { writeMode: "insert", ...(link.insertAboveLayerId ? { insertAboveLayerId: link.insertAboveLayerId } : {}) };
const overwriteProblem = (layer: KritaLayer) => layer.type !== "paintlayer" ? "非绘画图层" : layer.locked ? "已锁定" : layer.alphaLocked ? "Alpha 锁定" : layer.animated ? "动画图层" : layer.colorCompatible === false ? "色彩空间不兼容" : "";

async function captureKritaRead(ctx: CanvasNodeContext, documentId: string, layerId?: string) {
    const finishRead = beginKritaRead(ctx.projectId, ctx.node.id);
    if (!finishRead) throw new Error("此节点正在读取画面，请等待结果。");
    try {
        const snapshot = await createKritaSnapshot(documentId, layerId);
        const image = await uploadImage(await getKritaImage(snapshot.imageUrl));
        const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
        if (!((current?.kind === "source" || (current?.kind === "link" && current.mode === "read")) && current.documentId === documentId && current.layerId === layerId)) throw new Error("读取期间绑定文档或图层已变化，请重新读取。");
        ctx.updateMetadata({ ...imageMetadata(image), errorDetails: undefined, krita: { ...current, snapshot, lastReadKind: "manual" } });
    } finally { finishRead(); }
}

export async function sendKritaWrite(ctx: CanvasNodeContext, link: KritaLinkMetadata, status: KritaStatus | null, image: WriteInput, deliveryId?: string, deliveryKey?: string) {
    const writeKey = `write:${ctx.projectId}:${ctx.node.id}`;
    if (writingNodes.has(writeKey)) throw new Error("此节点正在写入，请等待结果。");
    writingNodes.add(writeKey);
    try {
        const document = status?.documents.find((item) => item.id === link.documentId);
        const pending = !!link.commandId && !!link.targetSnapshotId && !!link.sourceImage && !link.returnedLayerId;
        if (link.returnedLayerId && !deliveryId) throw new Error("本次结果已写入；请先准备下一次写入。");
        if (link.returnedLayerId && deliveryId && link.writeHistory?.some((record) => record.deliveryId === deliveryId)) return;
        if (pending && deliveryId && link.deliveryId !== deliveryId) throw new Error("上一次写入尚未确认，请先在面板中重试或检查。");
        if (link.commandId && !pending && !link.returnedLayerId) throw new Error("写入记录不完整，请在详细设置中检查。");
        const target = writeTarget(link);
        if (deliveryId && target.writeMode === "replace" && (target.replaceLayerId === link.managedLayerId || target.replaceLayerId === link.returnedLayerId) && !link.layerPixelSha256) throw new Error("旧结果层缺少覆盖校验。请先改为每次新建，或手动确认一次写回。");
        const stillCurrent = () => {
            if (!deliveryKey) return;
            const currentNode = ctx.getNode(ctx.node.id);
            const current = currentNode?.metadata?.krita;
            if (!currentNode || current?.kind !== "link" || current.mode !== "write" || current.documentId !== link.documentId || current.writeTargetMode !== link.writeTargetMode || current.insertAboveLayerId !== link.insertAboveLayerId || current.overwriteLayerId !== link.overwriteLayerId || current.newLayerPolicy !== link.newLayerPolicy || current.managedLayerId !== link.managedLayerId || current.fitToCanvas !== link.fitToCanvas || getKritaWriteDelivery(currentNode, ctx.getNodes(), ctx.getConnections())?.key !== deliveryKey) throw new Error("连线或写回目标已变化，未提交旧图片。");
        };
        stillCurrent();
        if (target.writeMode === "replace" && !target.replaceLayerId) throw new Error("请选择要覆盖的 Krita 图层。");
        if (!pending && target.writeMode === "insert" && !target.insertAboveLayerId) throw new Error("请选择新图层要插入到其上方的 Krita 图层。");
        let operation = link;
        let png: string;
        if (pending) {
            png = await asPng(await imageToDataUrl({ storageKey: link.sourceImage!.storageKey }));
        } else {
            if (!status?.connected || !document) throw new Error("请先连接 Krita 并选择目标文档。");
            const targetLayerId = target.writeMode === "replace" ? target.replaceLayerId : target.insertAboveLayerId;
            if (targetLayerId && !document.layers.some((item) => item.id === targetLayerId)) throw new Error("目标图层已不可用，请重新选择。");
            if (target.writeMode === "replace" && overwriteProblem(document.layers.find((item) => item.id === target.replaceLayerId)!)) throw new Error("所选图层不可覆盖，请选择未锁定的普通绘画图层。");
            if (!image) throw new Error("请从左侧连接一张有结果的图片。");
            const dataUrl = await imageToDataUrl({ storageKey: image.storageKey, url: image.url });
            if (!dataUrl) throw new Error("连接的图片尚无可读取的原图。");
            png = await asPng(dataUrl);
            const blob = await (await fetch(png)).blob();
            const bitmap = await createImageBitmap(blob);
            const width = bitmap.width, height = bitmap.height;
            bitmap.close();
            if ((width !== document.width || height !== document.height) && !link.fitToCanvas) throw new Error(`图片 ${width} × ${height} 与文档 ${document.width} × ${document.height} 不一致；勾选缩放副本后再写入。`);
            stillCurrent();
            const snapshot = await createKritaSnapshot(document.id);
            const stored = await uploadImage(blob);
            if (!stored.storageKey) throw new Error("无法保存待写入的原图。");
            try { stillCurrent(); } catch (error) { await deleteStoredImages([stored.storageKey]); throw error; }
            const expectedPriorLayerSha256 = target.writeMode === "replace" && link.layerPixelSha256 && (target.replaceLayerId === link.managedLayerId || target.replaceLayerId === link.returnedLayerId) ? link.layerPixelSha256 : undefined;
            const sourceDeliveryKey = deliveryKey || getKritaWriteDelivery(ctx.node, ctx.getNodes(), ctx.getConnections())?.key;
            operation = { ...link, commandId: crypto.randomUUID(), deliveryId, sourceDeliveryKey, expectedPriorLayerSha256, targetSnapshotId: snapshot.id, targetDocumentName: document.name, targetSessionId: snapshot.sessionId, sourceImage: { nodeId: image.node.id, storageKey: stored.storageKey, width, height }, returnedLayerId: undefined, returnedAt: undefined };
            await ctx.storage.set(writeKey, operation);
            ctx.updateMetadata({ ...imageMetadata(stored), status: "idle", errorDetails: undefined, krita: operation });
        }
        if (!pending) stillCurrent();
        const returned = await returnCanvasImage(operation.targetSnapshotId!, png.replace(/^data:image\/png;base64,/, ""), operation.commandId!, operation.fitToCanvas === true, target, { deliveryId: operation.deliveryId, expectedPriorLayerSha256: operation.expectedPriorLayerSha256 });
        const returnedAt = new Date().toISOString();
        const history = operation.writeHistory || [];
        const completed: KritaLinkMetadata = { ...operation, commandId: returned.commandId, returnedLayerId: returned.layerId, returnedAt, layerPixelSha256: returned.layerPixelSha256, managedLayerId: operation.writeTargetMode !== "overwrite" && operation.newLayerPolicy !== "always-new" ? returned.layerId : operation.managedLayerId, writeHistory: history.some((record) => record.commandId === returned.commandId || !!deliveryId && record.deliveryId === deliveryId) ? history : [...history, { commandId: returned.commandId, deliveryId, documentName: operation.targetDocumentName || document?.name || operation.documentId || "原目标文档", sourceNodeId: operation.sourceImage!.nodeId, layerId: returned.layerId, returnedAt, writeMode: target.writeMode, layerPixelSha256: returned.layerPixelSha256 }] };
        await ctx.storage.set(writeKey, completed);
        if (ctx.getNode(ctx.node.id)) ctx.updateMetadata({ status: "success", errorDetails: undefined, krita: completed });
    } finally {
        writingNodes.delete(writeKey);
    }
}

async function prepareNextKritaWrite(ctx: CanvasNodeContext, link: KritaLinkMetadata) {
    const writeKey = `write:${ctx.projectId}:${ctx.node.id}`;
    if (writingNodes.has(writeKey)) throw new Error("此节点正在写入，请等待结果后再操作。");
    await ctx.storage.remove(writeKey);
    ctx.updateMetadata({ content: undefined, storageKey: undefined, status: "idle", naturalWidth: undefined, naturalHeight: undefined, mimeType: undefined, bytes: undefined, krita: { ...link, commandId: undefined, deliveryId: undefined, sourceDeliveryKey: undefined, expectedPriorLayerSha256: undefined, targetSnapshotId: undefined, targetSessionId: undefined, sourceImage: undefined, returnedLayerId: undefined, returnedAt: undefined } });
}

async function abandonPendingKritaWrite(ctx: CanvasNodeContext, link: KritaLinkMetadata) {
    if (!link.commandId || link.returnedLayerId) return;
    if (!window.confirm("放弃待确认写入？该指令可能已经在 Krita 执行；放弃后不会自动重试，请先检查目标图层和本机备份，再手动写入新结果。")) return;
    await prepareNextKritaWrite(ctx, link);
}

function fitLinkToPreview(ctx: CanvasNodeContext, imageWidth: number, imageHeight: number) {
    const node = ctx.getNode(ctx.node.id);
    if (!node || !imageWidth || !imageHeight) return;
    const extent = Math.max(node.width, node.height);
    const ratio = imageWidth / imageHeight;
    const width = ratio >= 1 ? extent : extent * ratio;
    const height = ratio >= 1 ? extent / ratio : extent;
    const scale = Math.max(1, 220 / width, 160 / height);
    const nextWidth = Math.round(width * scale);
    const nextHeight = Math.round(height * scale);
    if (node.width !== nextWidth || node.height !== nextHeight) ctx.updateNode({ width: nextWidth, height: nextHeight });
}

function LinkContent({ ctx }: { ctx: CanvasNodeContext }) {
    const link: KritaLinkMetadata = ctx.node.metadata?.krita?.kind === "link" ? ctx.node.metadata.krita : { kind: "link", mode: "read" };
    const [busy, setBusy] = useState(false);
    const inputs = link.mode === "write" ? writeInputs(ctx) : null;
    const image = inputs?.count === 1 && inputs.images.length === 1 ? inputs.images[0] : null;
    const preview = link.mode === "read" ? link.snapshot && ctx.node.metadata?.content : link.commandId ? ctx.node.metadata?.content : image?.url;
    const writeKey = `write:${ctx.projectId}:${ctx.node.id}`;
    const modeLocked = busy || submittingNodes.has(writeKey) || writingNodes.has(writeKey) || (!!link.commandId && !link.returnedLayerId);
    const switchMode = async (mode: "read" | "write") => {
        const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
        if (current?.kind !== "link" || mode === current.mode || modeLocked) return;
        setBusy(true);
        try {
            if (current.mode === "write" && current.commandId) await ctx.storage.remove(writeKey);
            ctx.updateMetadata({ content: undefined, storageKey: undefined, status: "idle", naturalWidth: undefined, naturalHeight: undefined, mimeType: undefined, bytes: undefined, errorDetails: undefined, krita: { ...current, mode, autoRead: false, snapshot: undefined, commandId: undefined, deliveryId: undefined, sourceDeliveryKey: undefined, expectedPriorLayerSha256: undefined, targetSnapshotId: undefined, targetDocumentName: undefined, targetSessionId: undefined, sourceImage: undefined, returnedLayerId: undefined, returnedAt: undefined } });
        } catch (reason) { ctx.updateMetadata({ errorDetails: textOf(reason) }); }
        finally { setBusy(false); }
    };
    return <div className="relative h-full min-h-0 w-full overflow-hidden rounded-[inherit]" style={{ color: ctx.theme.node.text, background: ctx.theme.node.panel }}>
        {preview ? <img src={preview} alt={link.mode === "read" ? "Krita 已读取快照" : "准备写回 Krita 的图片"} className="pointer-events-none absolute inset-0 h-full w-full object-contain" draggable={false} onLoad={(event) => fitLinkToPreview(ctx, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : <div className="absolute inset-0 flex items-center justify-center px-6 pt-10 text-center text-xs opacity-60">{link.mode === "read" ? "点击节点，在控制面板选择文档与图层后读取" : inputs?.count ? "输入图片尚未就绪；点击节点查看" : "连接图片后，点击节点设置写回位置"}</div>}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between" data-canvas-no-zoom>
            <div className="grid size-8 shrink-0 place-items-center rounded-lg backdrop-blur-sm" style={{ background: ctx.theme.toolbar.panel }} title="Krita 连接"><img src="/icons/krita.png" alt="Krita" className="size-5" /></div>
            <div className="pointer-events-auto flex shrink-0 rounded-md border p-0.5 backdrop-blur-sm" style={{ borderColor: ctx.theme.node.stroke, background: ctx.theme.toolbar.panel }} role="group" aria-label="Krita Link 模式" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                {(["read", "write"] as const).map((mode) => <button key={mode} type="button" aria-pressed={link.mode === mode} title={modeLocked && link.mode !== mode ? "请等待当前写入完成或确认其结果" : undefined} disabled={modeLocked && link.mode !== mode} className={`rounded px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${link.mode === mode ? "font-semibold" : "opacity-65 hover:opacity-100"}`} style={link.mode === mode ? { background: ctx.theme.toolbar.activeBg } : undefined} onClick={() => void switchMode(mode)}>{mode === "read" ? "读取" : "写回"}</button>)}
            </div>
        </div>
        {link.mode === "read" ? <button type="button" role="switch" aria-label="Krita 自动读取" aria-checked={!!link.autoRead} disabled={!link.documentId} title={link.documentId ? "Auto 只更新读取图片；生图仍需手动，Auto 更新不会触发写回" : "先在控制面板绑定 Krita 文档"} className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs backdrop-blur-sm disabled:cursor-not-allowed disabled:opacity-50" style={{ background: link.autoRead ? ctx.theme.toolbar.activeBg : ctx.theme.toolbar.panel, borderColor: ctx.theme.node.stroke }} data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); const current = ctx.getNode(ctx.node.id)?.metadata?.krita; if (current?.kind === "link" && current.mode === "read" && current.documentId) ctx.updateMetadata({ errorDetails: undefined, krita: { ...current, autoRead: !current.autoRead } }); }}><span>Auto</span><span aria-hidden="true" className="flex h-4 w-7 items-center rounded-full p-0.5 transition-colors" style={{ background: link.autoRead ? ctx.theme.node.text : ctx.theme.node.stroke }}><span className={`size-3 rounded-full transition-transform ${link.autoRead ? "translate-x-3" : "translate-x-0"}`} style={{ background: ctx.theme.node.panel }} /></span></button> : null}
    </div>;
}

function WritePanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const link: KritaLinkMetadata = ctx.node.metadata?.krita?.kind === "link" ? ctx.node.metadata.krita : { kind: "link", mode: "write" };
    const writeKey = `write:${ctx.projectId}:${ctx.node.id}`;
    const [status, setStatus] = useState<KritaStatus | null>(null);
    const [connectionError, setConnectionError] = useState("");
    const [error, setError] = useState("");
    const [refreshing, setRefreshing] = useState(true);
    const [sending, setSending] = useState(false);
    const refresh = async (signal?: AbortSignal) => {
        setRefreshing(true); setConnectionError(""); setError("");
        try { setStatus(await getKritaStatus(signal)); } catch (reason) { if (!isAbort(reason)) { setStatus(null); setConnectionError(textOf(reason)); } }
        finally { if (!signal?.aborted) setRefreshing(false); }
    };
    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal);
        void ctx.storage.get<KritaLinkMetadata>(writeKey).then(async (saved) => {
            if (controller.signal.aborted) return;
            const restoredUrl = saved?.sourceImage ? await resolveImageUrl(saved.sourceImage.storageKey) : "";
            if (controller.signal.aborted) return;
            const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
            const supersedesCurrent = current?.kind === "link" && current.commandId && saved?.writeHistory?.some((record) => record.commandId === current.commandId);
            if (saved?.kind === "link" && saved.mode === "write" && saved.commandId && current?.kind === "link" && current.mode === "write" && ((!current.commandId || current.commandId === saved.commandId) && (!current.commandId || (!current.returnedLayerId && saved.returnedLayerId)) || supersedesCurrent)) ctx.updateMetadata({ krita: { ...current, ...saved }, status: saved.returnedLayerId ? "success" : "idle", ...(saved.sourceImage ? { content: restoredUrl || undefined, storageKey: saved.sourceImage.storageKey, naturalWidth: saved.sourceImage.width, naturalHeight: saved.sourceImage.height, mimeType: "image/png" } : {}) });
        }).catch(() => undefined);
        return () => controller.abort();
    }, [writeKey]);
    const connected = status?.connected === true;
    const document = connected ? status.documents.find((item) => item.id === link.documentId) : undefined;
    const inputs = writeInputs(ctx);
    const image = inputs.count === 1 && inputs.images.length === 1 ? inputs.images[0] : null;
    const imageWidth = link.sourceImage?.width || image?.node.metadata?.naturalWidth;
    const imageHeight = link.sourceImage?.height || image?.node.metadata?.naturalHeight;
    const dimensionsDiffer = !!document && !!imageWidth && !!imageHeight && (imageWidth !== document.width || imageHeight !== document.height);
    const pending = !!link.commandId && !!link.targetSnapshotId && !!link.sourceImage && !link.returnedLayerId;
    const target = writeTarget(link);
    const targetLayerId = target.writeMode === "replace" ? target.replaceLayerId : target.insertAboveLayerId;
    const selectedTargetLayer = document?.layers.find((item) => item.id === targetLayerId);
    const targetValid = !!selectedTargetLayer && (target.writeMode === "insert" || !overwriteProblem(selectedTargetLayer));
    const sessionValid = !pending || !link.targetSessionId || link.targetSessionId === status?.sessionId;
    const canSend = !sending && !link.returnedLayerId && (!link.commandId || pending) && (pending || (connected && !!document && sessionValid && targetValid && !!image && !!(image.url || image.storageKey) && (!dimensionsDiffer || !!link.fitToCanvas)));
    const patch = (value: Partial<KritaLinkMetadata>) => {
        const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
        if (current?.kind === "link" && current.mode === "write") ctx.updateMetadata({ krita: { ...current, ...value } });
    };
    const send = async () => {
        if (!canSend) return;
        submittingNodes.add(writeKey);
        setSending(true); setError("");
        try {
            const latest = pending ? status : await getKritaStatus();
            if (latest) setStatus(latest);
            if (!pending && (!latest?.connected || !latest.documents.some((item) => item.id === link.documentId))) throw new Error("Krita 未连接或目标文档尚未打开，请刷新文档后重试。");
            await sendKritaWrite(ctx, link, latest, image);
            await getKritaStatus().then(setStatus).catch(() => undefined);
        } catch (reason) {
            const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
            setError(`${textOf(reason)}${current?.kind === "link" && current.commandId ? " 重试会沿用同一写入编号，不会重复建层。" : ""}`);
        }
        finally { submittingNodes.delete(writeKey); setSending(false); }
    };
    return <PanelFrame ctx={ctx} title="Krita Link · 写入" onClose={onClose}>
        <div className="flex items-center justify-between gap-2"><span className="text-xs">{connected ? "Krita 已连接" : refreshing && !status ? "正在检查 Krita…" : "Krita 未连接"}</span><button className={buttonClass} disabled={refreshing || sending} onClick={() => void refresh()}>{refreshing ? "正在读取…" : "刷新文档"}</button></div>
        {connectionError ? <p role="alert" className="break-words text-xs">连接检查失败：{connectionError}</p> : null}
        {(status?.error) ? <p role="alert" className="break-words text-xs">{status.error}</p> : null}
        {!connected && !refreshing ? <p role="status" className="text-xs leading-5 opacity-60">请打开 Krita 和画稿后刷新文档；已有写回记录会保留。</p> : null}
        {connected ? <label className="block space-y-1.5"><span>目标文档</span><select aria-label="目标文档" className={fieldClass} style={controlStyle(ctx)} value={document?.id || ""} disabled={sending || pending} onChange={(event) => patch({ documentId: event.target.value, layerId: undefined, insertAboveLayerId: undefined, overwriteLayerId: undefined, managedLayerId: undefined, layerPixelSha256: undefined })}><option value="" disabled hidden>请选择文档</option>{!status.documents.length ? <option disabled>未打开文档</option> : null}{status.documents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.width} × {item.height}</option>)}</select></label> : null}
        {document || pending || link.returnedLayerId ? <div className="space-y-1 text-xs leading-5"><div>{link.returnedLayerId ? `本次已写入 · ${link.sourceImage?.width} × ${link.sourceImage?.height}` : pending ? `已冻结待写入原图 · ${link.sourceImage!.width} × ${link.sourceImage!.height}` : image ? `输入图片：${image.node.title}` : inputs.count ? "输入图片尚未就绪。" : "请从左侧连接一张图片。"}</div>{document && inputs.count > 1 && !pending ? <p role="alert">写入只接收一条图片连线；请断开多余连线。</p> : document && inputs.count === 1 && !image && !pending ? <p role="alert">输入节点尚无可用图片；若连接上游 Krita 写回，请先完成其写入。</p> : null}{document && image && !(image.url || image.storageKey) ? <p role="alert">输入图片尚无可读取的原图。</p> : null}{document ? <div className="opacity-60">新图片到达时写回一次；Krita 自动读取更新不会触发写回。仍可手动写入和重试。</div> : null}</div> : null}
        {document ? <>
        <label className="block space-y-1.5"><span>写回方式</span><select aria-label="写回方式" className={fieldClass} style={controlStyle(ctx)} value={link.writeTargetMode || "new"} disabled={sending || pending} onChange={(event) => patch({ writeTargetMode: event.target.value === "overwrite" ? "overwrite" : "new", managedLayerId: undefined, layerPixelSha256: undefined })}><option value="new">新建在所选图层上方</option><option value="overwrite">覆盖所选图层</option></select></label>
        {link.writeTargetMode !== "overwrite" ? <label className="flex items-center gap-2 text-xs leading-5" title="勾选后首次新建结果层，后续写回覆盖该层；取消勾选则每次都新建。"><input type="checkbox" checked={link.newLayerPolicy !== "always-new"} disabled={sending || pending} onChange={(event) => patch({ newLayerPolicy: event.target.checked ? "reuse" : "always-new", managedLayerId: undefined, layerPixelSha256: undefined })} /><span>仅首次新建</span></label> : null}
        <label className="block space-y-1.5"><span>{link.writeTargetMode === "overwrite" ? "要覆盖的图层" : "新图层插入位置"}</span><select aria-label={link.writeTargetMode === "overwrite" ? "要覆盖的图层" : "新图层插入位置"} className={fieldClass} style={controlStyle(ctx)} value={link.writeTargetMode === "overwrite" ? link.overwriteLayerId || "" : link.insertAboveLayerId || ""} disabled={sending || pending} onChange={(event) => patch({ [link.writeTargetMode === "overwrite" ? "overwriteLayerId" : "insertAboveLayerId"]: event.target.value || undefined, managedLayerId: undefined, layerPixelSha256: undefined })}><option value="" disabled hidden>请选择图层</option>{document.layers.map((item) => { const problem = link.writeTargetMode === "overwrite" ? overwriteProblem(item) : ""; return <option key={item.id} value={item.id} disabled={!!problem}>{item.name}{problem ? `（${problem}）` : ""}</option>; })}</select></label>
        {!pending && targetLayerId && !targetValid ? <p role="alert" className="text-xs">目标图层已不可用或不可覆盖，请重新选择。</p> : null}
        <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={link.fitToCanvas === true} disabled={sending || pending} onChange={(event) => patch({ fitToCanvas: event.target.checked })} /><span>{dimensionsDiffer ? `图片与目标文档尺寸不一致；` : "若图片与目标文档尺寸不一致，"}缩放副本至 {document.width} × {document.height} 后写入（可能变形）。输入原图保持不变。</span></label>
        <p className="text-xs leading-5 opacity-60">目标文档在提交时锁定；写入过程中请保持 Krita 和该文档开启。</p>
        {target.writeMode === "replace" ? <p role="note" className="text-xs leading-5">覆盖会替换目标图层画布范围内的像素。Krita 的 Python 写入可能不进入撤销栈；连接插件会先在本机保存该层 PNG 备份。写入前请确认目标图层。</p> : null}
        {link.writeTargetMode !== "overwrite" && link.newLayerPolicy !== "always-new" && link.managedLayerId ? <p className="text-xs leading-5">后续写回将覆盖首次新建的结果层（{link.managedLayerId.slice(0, 8)}）；更换文档、图层位置或策略会重新开始新建。</p> : null}
        </> : null}
        {connected && !sessionValid ? <p role="alert" className="text-xs">Krita 会话已变化，原写入指令不能投递到新会话；仍可查询本机写入记录。</p> : null}
        {error ? <p role="alert" className="break-words text-xs leading-5">{error}</p> : null}
        {ctx.node.metadata?.errorDetails ? <p role="alert" className="break-words text-xs leading-5">{ctx.node.metadata.errorDetails}</p> : null}
        {!link.returnedLayerId && (document || pending) ? <button className={`${buttonClass} w-full border`} style={{ borderColor: ctx.theme.node.stroke }} title={pending ? "先核对本机回执；若尚未完成，仅在原 Krita 会话可用时重试同一指令。" : undefined} disabled={!canSend} onClick={() => void send()}>{sending ? "正在写入…" : pending ? "核对／重试同一写入" : target.writeMode === "replace" ? "手动覆盖目标图层" : "手动新建并写回"}</button> : null}
        {pending && !link.returnedLayerId ? <button className={buttonClass} disabled={sending} onClick={() => void abandonPendingKritaWrite(ctx, link).catch((reason) => setError(textOf(reason)))}>放弃待确认指令，准备新写回</button> : null}
        {link.returnedLayerId ? <button className={`${buttonClass} border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={sending} onClick={() => void prepareNextKritaWrite(ctx, link).catch((reason) => setError(textOf(reason)))}>准备下一次写入</button> : null}
        {link.writeHistory?.length ? <section className="space-y-1 border-t pt-3 text-xs" style={{ borderColor: ctx.theme.node.stroke }}><div className="font-medium">写入记录</div>{[...link.writeHistory].reverse().map((record) => <div key={record.commandId} className="truncate">{record.documentName} · {new Date(record.returnedAt).toLocaleString()} · {record.writeMode === "replace" ? "覆盖" : "新增"}图层 {record.layerId.slice(0, 8)}</div>)}</section> : null}
    </PanelFrame>;
}

function LinkPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    return ctx.node.metadata?.krita?.kind === "link" && ctx.node.metadata.krita.mode === "write" ? <WritePanel ctx={ctx} onClose={onClose} /> : <SourcePanel ctx={ctx} onClose={onClose} />;
}

function SourceContent({ ctx }: { ctx: CanvasNodeContext }) {
    const snapshot = readSnapshot(ctx.node);
    return <div className="flex h-full flex-col gap-2 p-3" style={{ color: ctx.theme.node.text }}>
        {snapshot && ctx.node.metadata?.content ? <img src={ctx.node.metadata.content} alt={`Krita 快照：${snapshot.documentName}`} draggable={false} className="min-h-0 flex-1 object-contain" /> : <div className="flex flex-1 items-center justify-center text-xs opacity-60">选中文档后，手动读取一次画面</div>}
        <div className="truncate text-xs">{snapshot ? `${snapshot.documentName} · ${snapshot.width} × ${snapshot.height}` : ctx.node.type === KRITA_LINK ? "Krita Link · 读取" : "Krita 输入"}</div>
        <div className="text-[11px] opacity-60">静态快照 · 拖出连线可建立多个分支</div>
    </div>;
}

function SourcePanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const linked = ctx.node.type === KRITA_LINK;
    const current = ctx.node.metadata?.krita;
    const source: KritaSourceMetadata | KritaLinkMetadata = current?.kind === "source" || (current?.kind === "link" && current.mode === "read") ? current : linked ? { kind: "link", mode: "read" } : { kind: "source" };
    const [status, setStatus] = useState<KritaStatus | null>(null);
    const [connectionError, setConnectionError] = useState("");
    const [error, setError] = useState("");
    const [refreshing, setRefreshing] = useState(true);
    const [capturing, setCapturing] = useState(false);
    const refresh = async (signal?: AbortSignal) => {
        setRefreshing(true); setConnectionError(""); setError("");
        try { setStatus(await getKritaStatus(signal)); } catch (reason) { if (!isAbort(reason)) { setStatus(null); setConnectionError(textOf(reason)); } }
        finally { if (!signal?.aborted) setRefreshing(false); }
    };
    useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [ctx.node.id]);
    const connected = status?.connected === true;
    const document = connected ? status.documents.find((item) => item.id === source.documentId) : undefined;
    const bind = (documentId?: string, layerId?: string) => ctx.updateMetadata({ content: undefined, storageKey: undefined, status: "idle", errorDetails: undefined, krita: linked ? { ...source, kind: "link", mode: "read", autoRead: !!documentId && source.kind === "link" && !!source.autoRead, documentId, layerId, snapshot: undefined } : { kind: "source", documentId, layerId } });
    const capture = async () => {
        if (!connected || !document || capturing) return;
        setCapturing(true); setError("");
        try {
            await captureKritaRead(ctx, document.id, source.layerId);
        } catch (reason) { setError(textOf(reason)); } finally { setCapturing(false); }
    };
    return <PanelFrame ctx={ctx} title={linked ? "Krita Link · 读取" : "Krita 输入"} onClose={onClose}>
        <div className="flex items-center justify-between gap-2"><span className="text-xs">{connected ? "Krita 已连接" : refreshing && !status ? "正在检查 Krita…" : "Krita 未连接"}</span><button className={buttonClass} disabled={refreshing || capturing} onClick={() => void refresh()}>{refreshing ? "正在读取…" : "刷新文档"}</button></div>
        {connectionError ? <p role="alert" className="break-words text-xs">连接检查失败：{connectionError}</p> : null}
        {status?.error ? <p role="alert" className="break-words text-xs">{status.error}</p> : null}
        {!connected && !refreshing ? <p role="status" className="text-xs leading-5 opacity-60">请打开 Krita 和画稿后刷新文档；已有快照与绑定会保留。</p> : null}
        {connected ? <label className="block space-y-1.5"><span>绑定文档</span><select aria-label="绑定文档" className={fieldClass} style={controlStyle(ctx)} value={document?.id || ""} disabled={capturing} onChange={(event) => { const next = event.target.value; if (next !== source.documentId) bind(next); }}><option value="" disabled hidden>请选择文档</option>{!status.documents.length ? <option disabled>未打开文档</option> : null}{status.documents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.width} × {item.height}</option>)}</select></label> : null}
        {document ? <>
        <label className="block space-y-1.5"><span>读取范围</span><select aria-label="读取范围" className={fieldClass} style={controlStyle(ctx)} value={source.layerId || ""} disabled={capturing} onChange={(event) => { const next = event.target.value || undefined; if (next !== source.layerId) bind(source.documentId, next); }}><option value="">完整画面（可见图层合成）</option>{source.layerId && !document.layers.some((item) => item.id === source.layerId) ? <option value={source.layerId}>原图层暂不可用</option> : null}{document.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <p className="text-xs leading-5 opacity-60">{linked ? "可手动读取，也可在节点右下角开启 Auto 读取绑定的文档与图层。不会自动生成或写回；切换活动文档不会改变绑定。" : "手动读取，不自动生成；切换活动文档不会改变绑定。"}</p>
        <button className={`${buttonClass} w-full border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={capturing || (!!source.layerId && !document.layers.some((item) => item.id === source.layerId))} onClick={() => void capture()}>{capturing ? "正在保存快照…" : "读取当前画面"}</button>
        </> : null}
        {error ? <p role="alert" className="break-words rounded border px-2.5 py-2 text-xs leading-5" style={{ borderColor: ctx.theme.node.stroke }}>读取失败：{error}</p> : null}
        {linked && (document || !ctx.node.metadata?.errorDetails?.startsWith("Auto 读取：原绑定文档暂未打开")) && ctx.node.metadata?.errorDetails ? <p role="alert" className="break-words rounded border px-2.5 py-2 text-xs leading-5" style={{ borderColor: ctx.theme.node.stroke }}>{ctx.node.metadata.errorDetails}</p> : null}
        {source.snapshot ? <div className="space-y-1 break-words text-xs leading-5"><div>已读取：{source.snapshot.documentName}</div><div>{new Date(source.snapshot.createdAt).toLocaleString()} · {source.snapshot.width} × {source.snapshot.height}</div><div className="opacity-60">{source.snapshot.colorModel} / {source.snapshot.colorDepth} · {source.snapshot.colorProfile}</div><div className="opacity-60">快照 {source.snapshot.id.slice(0, 8)}；重新读取不会更改已提交任务。</div></div> : null}
    </PanelFrame>;
}

function PresetContent({ ctx }: { ctx: CanvasNodeContext }) {
    const settings = ctx.node.metadata?.krita;
    const upstream = ctx.getUpstream();
    const sourceCount = upstream.filter(isKritaReadNode).length;
    const styleCount = upstream.filter((node) => node.type === CanvasNodeType.Image).length;
    return <div className="flex h-full flex-col justify-between gap-3 p-4" style={{ color: ctx.theme.node.text }}><div><div className="text-sm font-medium">{settings?.kind === "preset" && settings.presetId === "detail" ? "保守细化" : "草稿改绘"}</div><p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs opacity-75">{ctx.node.metadata?.prompt || "选中节点，在右侧填写提示词与参数"}</p></div><div className="text-[11px] opacity-60">Krita 原稿 {sourceCount} · 风格图片 {styleCount} · 手动生成</div></div>;
}

function PresetPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const settings: KritaPresetMetadata = ctx.node.metadata?.krita?.kind === "preset" ? ctx.node.metadata.krita : { kind: "preset", presetId: "draft" };
    const configured = settings.backend === "configured";
    const [catalog, setCatalog] = useState<KritaPresetCatalog | null>(null);
    const [records, setRecords] = useState<KritaGeneration[]>([]);
    const [loadError, setLoadError] = useState("");
    const [presetError, setPresetError] = useState("");
    const [historyBusy, setHistoryBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [preparing, setPreparing] = useState(false);
    const refreshHistory = async (signal?: AbortSignal) => { setHistoryBusy(true); try { setRecords((await listKritaGenerations(signal)).generations); setLoadError(""); } catch (error) { if (!isAbort(error)) setLoadError(textOf(error)); } finally { if (!signal?.aborted) setHistoryBusy(false); } };
    useEffect(() => {
        if (configured) return;
        const controller = new AbortController();
        setPresetError("");
        void getKritaPresets(controller.signal).then(setCatalog).catch((error) => { if (!isAbort(error)) setPresetError(textOf(error)); });
        return () => controller.abort();
    }, [ctx.node.id, configured]);
    useEffect(() => {
        const controller = new AbortController();
        void refreshHistory(controller.signal);
        return () => controller.abort();
    }, [ctx.node.id]);
    const upstream = ctx.getUpstream();
    const sources = upstream.filter(isKritaReadNode);
    const snapshot = sources[0] ? readSnapshot(sources[0]) : undefined;
    const imageInputs = upstream.filter((node) => node.type === CanvasNodeType.Image);
    const styleNode = imageInputs[0];
    const styleReady = !styleNode || !!(styleNode.metadata?.content || styleNode.metadata?.storageKey);
    const styleWeight = settings.styleWeight ?? 0.6;
    const styleWeightValid = Number.isFinite(styleWeight) && styleWeight >= 0 && styleWeight <= 1;
    const invalidInputs = sources.length > 1 || imageInputs.length > 1;
    const textInputs = upstream.filter((node) => node.type === CanvasNodeType.Text).map((node) => node.metadata?.content || node.metadata?.prompt || "").filter(Boolean);
    const preset = catalog?.presets.find((item) => item.id === settings.presetId);
    const configuredModels = ctx.ai.listModels("image");
    const configuredModel = settings.configuredModel || ctx.ai.defaultModel("image");
    const modelAvailable = configured ? configuredModels.some((item) => item.value === configuredModel) : !!settings.model && !!catalog?.models.includes(settings.model);
    const params = { ...preset?.defaults, seed: -1, ...settings.params };
    const busy = isKritaNodeBusy(ctx.node.id) || preparing;
    const supports = (key: string) => !preset?.supported || preset.supported.includes(key);
    const patch = (value: Partial<KritaPresetMetadata>) => patchKritaPreset(ctx, value);
    const setParam = (key: keyof KritaGenerationParams, value: string) => patch({ params: { ...settings.params, [key]: key === "sampler" || key === "scheduler" ? value : Number(value) } });
    const generate = async () => {
        if (!snapshot || !modelAvailable || busy || invalidInputs || !styleReady || (styleNode && (configured || !styleWeightValid || !catalog?.styleAvailable)) || (!configured && !preset)) return;
        const prompt = [...textInputs, ctx.node.metadata?.prompt || ""].filter(Boolean).join("\n\n").trim();
        if (!prompt) { setNotice("请填写提示词或连接文字节点。"); return; }
        setNotice("");
        if (configured) { void submitConfiguredKritaGeneration(ctx, snapshot, prompt, configuredModel); return; }
        const request = { snapshotId: snapshot.id, prompt, negativePrompt: settings.negativePrompt || "", model: settings.model!, presetId: preset!.id,
            params: { steps: Number(params.steps), cfg: Number(params.cfg), denoise: Number(params.denoise), seed: Number(params.seed), sampler: String(params.sampler || ""), scheduler: String(params.scheduler || "") } };
        if (!styleNode) { void submitKritaGeneration(ctx, request); return; }
        setPreparing(true);
        try {
            const dataUrl = await imageToDataUrl({ storageKey: styleNode.metadata?.storageKey, url: styleNode.metadata?.content });
            if (!dataUrl) throw new Error("连接的图片尚无可读取的原图。");
            const styleImage = await asPng(dataUrl);
            void submitKritaGeneration(ctx, { ...request, styleImage, styleWeight });
        } catch (error) { setNotice(`读取风格参考失败：${textOf(error)}`); }
        finally { setPreparing(false); }
    };
    return <PanelFrame ctx={ctx} title="预设生成" onClose={onClose}>
        <div className="space-y-1 text-xs leading-5"><div>{snapshot ? `原稿：${snapshot.documentName} · 快照 ${snapshot.id.slice(0, 8)}` : "请连接一个已读取画面的 Krita 输入节点。"}</div><div>{styleNode ? `风格参考：${styleNode.title}（当前显示图片）` : "可再连接一张普通图片作为风格参考；不连接时沿用原稿改绘。"}</div>{styleNode ? <div className="opacity-60">风格图仅用于本机 ComfyUI 的 SDXL 风格适配器；请选用 SDXL 模型。Krita 快照提供原稿构图。</div> : null}{invalidInputs ? <div role="alert">请只保留一个 Krita 输入和最多一张风格图片。</div> : null}{!styleReady ? <div role="alert">风格图片尚无可读取的原图。</div> : null}{styleNode && configured ? <div role="alert">风格参考目前只支持本机 ComfyUI，请切换生成渠道或断开风格图片。</div> : null}{styleNode && !configured && catalog && !catalog.styleAvailable ? <div role="alert">本机 ComfyUI 缺少此功能所需的 SDXL IP-Adapter 或 CLIP Vision 模型。</div> : null}{textInputs.length ? <div>连接文字 {textInputs.length} 个，会与下方提示词合并。</div> : null}</div>
        <label className="block space-y-1.5"><span>生成渠道</span><select aria-label="生成渠道" className={fieldClass} style={controlStyle(ctx)} value={configured ? "configured" : "comfy"} disabled={busy} onChange={(event) => patch({ backend: event.target.value === "configured" ? "configured" : "comfy" })}><option value="comfy">本机 ComfyUI</option><option value="configured">已配置生图渠道（含 Codex）</option></select></label>
        {!configured ? <>
        <label className="block space-y-1.5"><span>生成预设</span><select aria-label="生成预设" className={fieldClass} style={controlStyle(ctx)} value={settings.presetId} disabled={busy || !catalog} onChange={(event) => { const next = catalog?.presets.find((item) => item.id === event.target.value); if (next) { patch({ presetId: next.id, params: { ...next.defaults, seed: settings.params?.seed ?? -1 } }); setNotice("已使用该预设的默认参数；模型和提示词保持不变。"); } }}>{!catalog ? <option value={settings.presetId}>正在读取预设…</option> : catalog.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="block space-y-1.5"><span>本机模型</span><select aria-label="本机模型" className={fieldClass} style={controlStyle(ctx)} value={settings.model || ""} disabled={busy || !catalog?.available} onChange={(event) => patch({ model: event.target.value || undefined })}><option value="">请选择已有模型</option>{settings.model && !catalog?.models.includes(settings.model) ? <option value={settings.model}>{settings.model}（当前不可用）</option> : null}{catalog?.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
        </> : <><label className="block space-y-1.5"><span>渠道模型</span><select aria-label="渠道模型" className={fieldClass} style={controlStyle(ctx)} value={configuredModel} disabled={busy} onChange={(event) => patch({ configuredModel: event.target.value })}>{!configuredModel ? <option value="">请先配置生图模型</option> : !modelAvailable ? <option value={configuredModel}>{configuredModel}（当前不可用）</option> : null}{configuredModels.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label><p className="text-xs leading-5 opacity-60">沿用设置中的渠道、模型与参考图能力。仅发送提示词和这张源图；采样参数不适用于此渠道。请求尺寸为源画布尺寸，实际模型及输出尺寸以渠道结果为准，不保证指定 Image2 或精确尺寸。</p></>}
        <label className="block space-y-1.5"><span>提示词</span><textarea aria-label="提示词" rows={4} className={fieldClass} style={controlStyle(ctx)} value={ctx.node.metadata?.prompt || ""} onChange={(event) => ctx.updateMetadata({ prompt: event.target.value })} placeholder="描述希望在草稿基础上得到的结果" /></label>
        {!configured ? <><label className="block space-y-1.5"><span>反向提示词</span><textarea aria-label="反向提示词" rows={2} className={fieldClass} style={controlStyle(ctx)} value={settings.negativePrompt || ""} onChange={(event) => patch({ negativePrompt: event.target.value })} /></label>
        {supports("denoise") ? <label className="block space-y-1.5"><span>改绘强度</span><input aria-label="改绘强度" type="number" step="0.01" className={fieldClass} style={controlStyle(ctx)} value={params.denoise ?? ""} onChange={(event) => setParam("denoise", event.target.value)} /><span className="block text-xs opacity-60">越低越接近输入；按源快照生成，尺寸以实际输出为准。</span></label> : null}
        {styleNode ? <label className="block space-y-1.5"><span>风格权重</span><input aria-label="风格权重" type="number" min="0" max="1" step="0.05" className={fieldClass} style={controlStyle(ctx)} value={styleWeight} onChange={(event) => patch({ styleWeight: Number(event.target.value) })} /><span className="block text-xs opacity-60">范围 0–1，默认 0.6；越高越偏向参考图的风格，改绘强度仍控制原稿变化。</span>{!styleWeightValid ? <span role="alert" className="block text-xs">风格权重必须在 0–1 之间。</span> : null}</label> : null}
        <details><summary className="cursor-pointer text-xs">高级参数</summary><div className="mt-3 grid grid-cols-2 gap-3">
            {([['steps', '采样步数'], ['cfg', '提示词强度'], ['seed', '种子（-1 随机）']] as const).filter(([key]) => supports(key)).map(([key, label]) => <label key={key} className="block space-y-1.5"><span className="text-xs">{label}</span><input aria-label={label} type="number" step={key === "cfg" ? "0.1" : "1"} className={fieldClass} style={controlStyle(ctx)} value={params[key] ?? ""} onChange={(event) => setParam(key, event.target.value)} /></label>)}
            {(['sampler', 'scheduler'] as const).filter(supports).map((key) => <label key={key} className="col-span-2 block space-y-1.5"><span className="text-xs">{key === "sampler" ? "采样器" : "调度方式"}</span><select aria-label={key === "sampler" ? "采样器" : "调度方式"} className={fieldClass} style={controlStyle(ctx)} value={params[key] || ""} onChange={(event) => setParam(key, event.target.value)}><option value="">请选择</option>{(key === "sampler" ? catalog?.samplers : catalog?.schedulers)?.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>)}
        </div></details>
        </> : null}
        {(loadError || (!configured && (presetError || catalog?.error)) || notice || ctx.node.metadata?.errorDetails) ? <p role="status" className="break-words text-xs leading-5">{notice || ctx.node.metadata?.errorDetails || loadError || (!configured && (presetError || catalog?.error))}</p> : null}
        <div className="flex gap-2"><button className={`${buttonClass} flex-1 border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={busy || (!configured && !catalog?.available) || !modelAvailable || sources.length !== 1 || !snapshot || invalidInputs || !styleReady || (!!styleNode && (configured || !styleWeightValid || !catalog?.styleAvailable))} onClick={() => void generate()}>{preparing ? "正在读取风格图片…" : busy ? "正在等待结果…" : "手动生成新结果"}</button>{!preparing && isKritaNodeBusy(ctx.node.id) && !configured && settings.generationId ? <button className={buttonClass} onClick={() => stopKritaWaiting(ctx.node.id)}>停止等待</button> : null}</div>
        <p className="text-xs leading-5 opacity-60">提交时保存输入与实际参数；重新读取或继续绘画不会改动该任务。停止等待、刷新或等待超时后，后台可能继续；不会自动重试生成。</p>
        {configured ? <p className="text-xs leading-5 opacity-60">配置渠道完成后才写入本机任务记录。等待期间请保留页面；若刷新或关闭，请先检查该渠道自己的记录，勿直接重复生成。</p> : null}
        <section className="space-y-2 border-t pt-3" style={{ borderColor: ctx.theme.node.stroke }}><div className="flex items-center justify-between"><span className="font-medium">任务记录</span><button className={buttonClass} disabled={historyBusy} onClick={() => void refreshHistory()}>{historyBusy ? "读取中…" : "刷新记录"}</button></div>
            {settings.generationId ? <div className="flex items-center justify-between gap-2 text-xs"><span className="truncate">上次任务 {settings.generationId.slice(0, 8)}</span><button className={buttonClass} disabled={busy} onClick={() => void followKritaGeneration(ctx, settings.generationId!)}>查看 / 继续等待</button></div> : null}
            <div className="max-h-64 space-y-2 overflow-y-auto">{records.map((job) => <div key={job.id} className="border-t pt-2 text-xs" style={{ borderColor: ctx.theme.node.stroke }}><div className="flex items-center justify-between gap-2"><span className="truncate">{job.request.documentName || "原绑定文档"} · {jobLabel[job.status]}</span><button className={buttonClass} disabled={busy} onClick={() => void followKritaGeneration(ctx, job.id)}>{job.status === "succeeded" ? "加入结果" : "查看任务"}</button></div><div className="mt-1 truncate opacity-60">{job.id.slice(0, 8)} · {job.request.prompt}</div>{job.request.styleReference ? <div className="mt-1 opacity-60">风格参考 {job.request.styleReference.width} × {job.request.styleReference.height} · 权重 {job.request.styleWeight}</div> : null}{job.error ? <div className="mt-1 break-words">{job.error}</div> : null}</div>)}</div>
        </section>
    </PanelFrame>;
}

export function KritaResultPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const result = ctx.node.metadata?.krita;
    const [status, setStatus] = useState<KritaStatus | null>(null);
    const [error, setError] = useState("");
    const [sending, setSending] = useState(false);
    const refresh = async (signal?: AbortSignal) => { try { setStatus(await getKritaStatus(signal)); setError(""); } catch (reason) { if (!isAbort(reason)) { setStatus(null); setError(textOf(reason)); } } };
    useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [ctx.node.id]);
    if (result?.kind !== "result") return null;
    const documentOpen = status?.documents.some((item) => item.id === result.request.documentId);
    const sessionMatches = !result.request.sessionId || result.request.sessionId === status?.sessionId;
    const targetWidth = result.request.sourceWidth;
    const targetHeight = result.request.sourceHeight;
    const dimensionsDiffer = !!targetWidth && !!targetHeight && (result.imageWidth !== targetWidth || result.imageHeight !== targetHeight);
    const fitToCanvas = result.fitToCanvas === true;
    const send = async () => {
        if (sending || result.returnedLayerId || !status?.connected || !documentOpen || !sessionMatches || (dimensionsDiffer && !fitToCanvas)) return;
        const commandId = result.commandId || crypto.randomUUID();
        ctx.updateMetadata({ krita: { ...result, commandId } });
        setSending(true); setError("");
        try { const returned = await returnKritaImage(result.generationId, result.imageId, commandId, fitToCanvas); ctx.updateMetadata({ krita: { ...result, commandId, returnedLayerId: returned.layerId, returnedAt: new Date().toISOString() } }); }
        catch (reason) { setError(`${textOf(reason)} 再次操作会沿用同一回传编号，避免重复建层。`); }
        finally { setSending(false); }
    };
    return <PanelFrame ctx={ctx} title="回传生成原图" onClose={onClose}>
        <div className="space-y-2 text-sm"><div>目标文档：<strong>{result.request.documentName || "原绑定文档"}</strong></div><p className="text-xs leading-5 opacity-60">目标绑定生成时的快照，不跟随 Krita 当前活动文档。只新增图层，不覆盖原层；回传的是这次任务的原始结果，画布中后续的裁剪等操作不改变该原图。</p></div>
        <div className="text-xs leading-5"><div>任务 {result.generationId.slice(0, 8)} · 快照 {result.snapshotId.slice(0, 8)}</div><div className="break-words">模型：{result.request.model}</div>{result.request.backend !== "configured" ? <><div>步数 {result.request.params.steps} · 强度 {result.request.params.cfg} · 改绘 {result.request.params.denoise}</div><div>种子 {result.request.params.seed}</div>{result.request.styleReference ? <div>风格参考 {result.request.styleReference.width} × {result.request.styleReference.height} · 权重 {result.request.styleWeight}</div> : null}</> : <div>已配置渠道；不应用 ComfyUI 采样参数。</div>}<div>原始结果 {result.imageWidth} × {result.imageHeight}{targetWidth && targetHeight ? ` · 原画布 ${targetWidth} × ${targetHeight}` : ""}</div></div>
        {dimensionsDiffer ? <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={fitToCanvas} disabled={sending || !!result.commandId || !!result.returnedLayerId} onChange={(event) => ctx.updateMetadata({ krita: { ...result, fitToCanvas: event.target.checked } })} /><span>缩放副本至原画布尺寸后回传（可能变形）。存档原图和原文档尺寸保持不变；首次回传后锁定此选项，重试沿用同一指令。</span></label> : null}
        <div className="flex items-center justify-between text-xs"><span>{status?.connected ? "Krita 已连接" : "Krita 未连接"}</span><button className={buttonClass} onClick={() => void refresh()}>刷新连接</button></div>
        {status?.connected && (!documentOpen || !sessionMatches) ? <p role="status" className="text-xs leading-5">原绑定文档或原会话暂不可用，已禁用回传；请保留结果。不会改投当前活动文档。</p> : null}
        {error ? <p role="alert" className="break-words text-xs leading-5">{error}</p> : null}
        <button className={`${buttonClass} w-full border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={sending || !!result.returnedLayerId || !status?.connected || !documentOpen || !sessionMatches || (dimensionsDiffer && !fitToCanvas)} onClick={() => void send()}>{result.returnedLayerId ? "已回传为新图层" : sending ? "正在回传…" : "回传到原文档新图层"}</button>
        {result.returnedAt ? <p className="text-xs opacity-60">完成于 {new Date(result.returnedAt).toLocaleString()}；普通点击不会重复建层。</p> : null}
    </PanelFrame>;
}

export function getKritaToolbar(ctx: CanvasNodeContext): CanvasNodeToolbarItem[] {
    if (!isKritaResultNode(ctx.node)) return [];
    const returned = ctx.node.metadata?.krita?.kind === "result" && ctx.node.metadata.krita.returnedLayerId;
    return [{ id: "krita-return", title: returned ? "查看回传记录" : "回传到原 Krita 文档的新图层", label: returned ? "已回传" : "回传 Krita", icon: <ArrowUpRight className="size-4" />, onClick: ctx.openPanel }];
}

let registered = false;
export function registerLocalKritaNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([
        { type: KRITA_LINK, title: "Krita Link", icon: <img src="/icons/krita.png" alt="" className="size-4" />, description: "在节点上切换读取或新图写回 Krita", defaultSize: { width: 360, height: 360 }, defaultMetadata: { krita: { kind: "link", mode: "read", writeTargetMode: "new", newLayerPolicy: "reuse" } }, hasSourceHandle: (node) => node.metadata?.krita?.kind === "link", hasTargetHandle: (node) => node.metadata?.krita?.kind === "link" && node.metadata.krita.mode === "write", keepAspectRatio: () => true, Content: LinkContent, Panel: LinkPanel, resource: (node) => node.metadata?.krita?.kind === "link" && node.metadata.content && (node.metadata.krita.mode === "read" || hasKritaWriteOutput(node)) ? { kind: "image", url: node.metadata.content } : null },
        { type: KRITA_SOURCE, title: "Krita 输入", icon: <Brush className="size-4" />, description: "旧画布中的 Krita 读取节点", showInCreateMenu: false, defaultSize: { width: 320, height: 250 }, defaultMetadata: { krita: { kind: "source" } }, autoOpenPanel: true, panelPlacement: "right", keepAspectRatio: () => true, Content: SourceContent, Panel: SourcePanel, resource: (node) => node.metadata?.content ? { kind: "image", url: node.metadata.content } : null },
        { type: KRITA_PRESET, title: "Krita 预设生成", icon: <Settings2 className="size-4" />, description: "旧画布中的 Krita 预设", showInCreateMenu: false, defaultSize: { width: 300, height: 210 }, defaultMetadata: { prompt: "", krita: { kind: "preset", presetId: "draft" } }, autoOpenPanel: true, panelPlacement: "right", Content: PresetContent, Panel: PresetPanel },
    ], "local-krita-link");
}
