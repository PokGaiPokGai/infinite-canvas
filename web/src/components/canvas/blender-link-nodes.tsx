import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { BLENDER_LINK, blenderWriteInput, hasBlenderWriteOutput } from "@/lib/canvas/blender-link";
import { asPng } from "@/lib/canvas/krita-link";
import { createBlenderSnapshot, getBlenderImage, getBlenderImagePreview, getBlenderStatus, writeBlenderTexture } from "@/services/api/blender-link";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { useBlenderConnectionStore } from "@/stores/use-blender-connection-store";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { BlenderDestination, BlenderImagePreview, BlenderLinkMetadata, BlenderStatus } from "@/types/blender-link";
import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";

const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const fieldClass = "w-full rounded border px-2.5 py-2 text-sm outline-none focus:ring-1 disabled:opacity-40";
const active = new Set<string>();
const textOf = (error: unknown) => error instanceof Error ? error.message : "Blender Link 暂时不可用。";
const emptyPreview = { content: undefined, storageKey: undefined, naturalWidth: undefined, naturalHeight: undefined, mimeType: undefined, bytes: undefined, errorDetails: undefined, status: "idle" as const };

function fitPreview(ctx: CanvasNodeContext, width: number, height: number) {
    const node = ctx.getNode(ctx.node.id);
    if (!node || width <= 0 || height <= 0 || Math.abs(node.width / node.height - width / height) < 0.001) return;
    const ratio = width / height;
    const extent = Math.max(node.width, node.height);
    const nextWidth = ratio >= 1 ? extent : extent * ratio;
    const nextHeight = ratio >= 1 ? extent / ratio : extent;
    const scale = Math.max(1, 220 / nextWidth, 160 / nextHeight);
    ctx.updateNode({ width: Math.round(nextWidth * scale), height: Math.round(nextHeight * scale) });
}

async function captureBlenderRead(ctx: CanvasNodeContext, link: BlenderLinkMetadata) {
    const key = `${ctx.projectId}:${ctx.node.id}`;
    if (link.mode !== "read" || !link.sessionId || !link.sourceId || link.pending || active.has(key) || useBlenderConnectionStore.getState().saving) return;
    const revision = useBlenderConnectionStore.getState().revision;
    active.add(key);
    ctx.updateMetadata({ status: "loading", errorDetails: undefined });
    try {
        const snapshot = await createBlenderSnapshot(link.sessionId, link.sourceId);
        const image = await uploadImage(await getBlenderImage(snapshot.imageUrl));
        const current = ctx.getNode(ctx.node.id)?.metadata?.blender;
        if (!current) return;
        if (current.mode !== "read" || current.sessionId !== link.sessionId || current.sourceId !== link.sourceId || revision !== useBlenderConnectionStore.getState().revision) {
            ctx.updateMetadata({ status: "idle" });
            return;
        }
        ctx.updateMetadata({ ...imageMetadata(image), blender: { ...current, snapshot } });
    } catch (error) { if (ctx.getNode(ctx.node.id)) ctx.updateMetadata({ status: "error", errorDetails: textOf(error) }); }
    finally { active.delete(key); }
}

function LinkContent({ ctx }: { ctx: CanvasNodeContext }) {
    const port = useBlenderConnectionStore(state => state.port);
    const savingConnection = useBlenderConnectionStore(state => state.saving);
    useEffect(() => { void useBlenderConnectionStore.getState().load().catch(() => {}); }, []);
    const link: BlenderLinkMetadata = ctx.node.metadata?.blender || { mode: "read" };
    const input = link.mode === "write" ? blenderWriteInput(ctx.node, ctx.getNodes(), ctx.getConnections()) : null;
    const preview = link.mode === "write" && !link.pending ? input?.url || ctx.node.metadata?.content : ctx.node.metadata?.content;
    const key = `${ctx.projectId}:${ctx.node.id}`;
    const reading = link.mode === "read" && ctx.node.metadata?.status === "loading" && active.has(key);
    const locked = reading || savingConnection || !!link.pending || active.has(key);
    const changeMode = (mode: BlenderLinkMetadata["mode"]) => {
        if (locked || mode === link.mode) return;
        const next = { ...link, mode, snapshot: undefined, receipt: undefined, writtenInputKey: undefined };
        ctx.updateMetadata({ ...emptyPreview, blender: next });
        if (mode === "read") void captureBlenderRead(ctx, next);
    };
    return <div className="relative h-full w-full overflow-hidden rounded-[inherit]" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text }}>
        {preview ? <img src={preview} alt={link.mode === "read" ? "Blender 画面快照" : "写回 Blender 的贴图"} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" onLoad={event => fitPreview(ctx, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : <div className="absolute inset-0 flex items-center justify-center px-6 pt-10 text-center text-xs opacity-60">{link.mode === "read" ? "点击节点，选择 Blender 视口或最近渲染结果" : "连接图片，点击节点选择目标贴图或新建图片"}</div>}
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between" data-canvas-no-zoom>
            <div className="grid size-8 shrink-0 place-items-center rounded-lg backdrop-blur-sm" style={{ background: ctx.theme.toolbar.panel }} title="Blender Link"><img src="/icons/blender.svg" alt="Blender" className="size-5" /></div>
            <div role="group" aria-label="Blender Link 模式" className="pointer-events-auto flex rounded-md border p-0.5 backdrop-blur-sm" style={{ background: ctx.theme.toolbar.panel, borderColor: ctx.theme.node.stroke }} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
                {(["read", "write"] as const).map(mode => <button key={mode} type="button" aria-pressed={link.mode === mode} disabled={locked && mode !== link.mode} className={`rounded px-2 py-1 text-[11px] disabled:opacity-40 ${link.mode === mode ? "font-semibold" : "opacity-65 hover:opacity-100"}`} style={link.mode === mode ? { background: ctx.theme.toolbar.activeBg } : undefined} onClick={event => { event.stopPropagation(); changeMode(mode); }}>{mode === "read" ? "读取" : "写回"}</button>)}
            </div>
        </div>
        <div className="absolute bottom-3 right-3 z-10 flex h-8 items-center gap-1.5" style={{ color: "var(--blender-link-orange)" }} data-canvas-no-zoom>
            <span className="pointer-events-none select-none text-[11px] tabular-nums opacity-40" title={port === null ? "正在读取连接设置" : `BlenderMCP · 127.0.0.1:${port}`}>{port ?? "—"}</span>
            {link.mode === "read" ? <button type="button" aria-label="读取当前画面" aria-busy={reading} title={!link.sessionId || !link.sourceId ? "先在控制面板选择视口" : reading ? "正在读取当前画面…" : "读取当前画面"} disabled={locked || !link.sessionId || !link.sourceId} className="grid size-8 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void captureBlenderRead(ctx, link); }}><RefreshCw className={`size-4 ${reading ? "motion-safe:animate-spin" : ""}`} /></button> : null}
        </div>
    </div>;
}

function LinkPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const panelRect = useCanvasPopoverAnchor(panelRef, true);
    const link: BlenderLinkMetadata = ctx.node.metadata?.blender || { mode: "read" };
    const [status, setStatus] = useState<BlenderStatus | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [recovering, setRecovering] = useState(true);
    const [working, setWorking] = useState(false);
    const [connectionError, setConnectionError] = useState("");
    const [imagePreview, setImagePreview] = useState<{ status: BlenderStatus; value: BlenderImagePreview } | null>(null);
    const [previewError, setPreviewError] = useState("");
    const connectionRevision = useBlenderConnectionStore(state => state.revision);
    const connectionPort = useBlenderConnectionStore(state => state.port);
    const savingConnection = useBlenderConnectionStore(state => state.saving);
    const [portDraft, setPortDraft] = useState(() => String(useBlenderConnectionStore.getState().port ?? 9876));
    const validPort = /^\d+$/.test(portDraft) && Number(portDraft) >= 1 && Number(portDraft) <= 65535;
    useEffect(() => { if (connectionPort !== null) setPortDraft(String(connectionPort)); }, [connectionPort]);
    const key = `${ctx.projectId}:${ctx.node.id}`;
    const storageKey = `write:${key}`;
    const busy = working || savingConnection || active.has(key) || recovering;
    const locked = busy || !!link.pending;
    const connected = status?.connected === true;
    const sameSession = connected && status.sessionId === link.sessionId;
    const source = sameSession ? status.sources.find(item => item.id === link.sourceId) : undefined;
    const material = sameSession ? status.targets.find(item => item.materialId === link.materialId) : undefined;
    const target = sameSession ? status.targets.find(item => item.id === link.targetId && item.materialId === link.materialId) : undefined;
    const materials = [...new Map((status?.targets || []).map(item => [item.materialId, item])).values()];
    const writeMode = link.writeMode || "image";
    const image = sameSession ? status.images.find(item => item.id === link.imageId) : undefined;
    const preview = imagePreview?.status === status && imagePreview?.value.imageId === image?.id ? imagePreview.value : null;
    const destination: BlenderDestination | null = writeMode === "image" ? image && preview ? { kind: "image", imageId: image.id, expectedRevision: preview.revision } : null
        : writeMode === "new" ? (link.imageName ?? "Canvas Result").trim() ? { kind: "new", name: (link.imageName ?? "Canvas Result").trim() } : null
        : target ? { kind: "node", targetId: target.id, expectedImageId: target.imageId } : null;
    const input = blenderWriteInput(ctx.node, ctx.getNodes(), ctx.getConnections());
    const controlStyle = { background: ctx.theme.node.panel, color: ctx.theme.node.text, borderColor: ctx.theme.node.stroke };
    const refresh = async (signal?: AbortSignal) => {
        const revision = useBlenderConnectionStore.getState().revision;
        setRefreshing(true); setConnectionError("");
        try {
            const result = await getBlenderStatus(signal);
            if (!signal?.aborted && revision === useBlenderConnectionStore.getState().revision) {
                setStatus(result); setPortDraft(String(result.port));
                if (!useBlenderConnectionStore.getState().saving) useBlenderConnectionStore.setState({ port: result.port });
            }
        }
        catch (error) { if (!signal?.aborted) { setStatus(null); setConnectionError(textOf(error)); } }
        finally { if (!signal?.aborted) setRefreshing(false); }
    };
    useEffect(() => {
        const controller = new AbortController();
        setStatus(null);
        void refresh(controller.signal);
        return () => controller.abort();
    }, [key, connectionRevision]);
    useEffect(() => {
        const controller = new AbortController();
        void ctx.storage.get<CanvasNodeMetadata>(storageKey).then(saved => {
            if (!controller.signal.aborted && saved?.blender?.pending && !ctx.getNode(ctx.node.id)?.metadata?.blender?.pending) ctx.updateMetadata(saved);
        }).catch(error => { if (!controller.signal.aborted) setConnectionError(textOf(error)); }).finally(() => { if (!controller.signal.aborted) setRecovering(false); });
        return () => controller.abort();
    }, [key]);
    const connect = async () => {
        setConnectionError("");
        try { await useBlenderConnectionStore.getState().save(Number(portDraft)); }
        catch (error) { setConnectionError(textOf(error)); }
    };
    useEffect(() => {
        setImagePreview(null); setPreviewError("");
        if (link.mode !== "write" || writeMode !== "image" || !image || !status?.sessionId) return;
        const controller = new AbortController();
        void getBlenderImagePreview(status.sessionId, image.id, controller.signal)
            .then(value => { if (!controller.signal.aborted) setImagePreview({ status, value }); })
            .catch(error => { if (!controller.signal.aborted) setPreviewError(textOf(error)); });
        return () => controller.abort();
    }, [status, link.mode, writeMode, image?.id]);
    const patch = (value: Partial<BlenderLinkMetadata>) => {
        const next = { ...link, ...value, snapshot: undefined, receipt: undefined, writtenInputKey: undefined };
        ctx.updateMetadata({ ...emptyPreview, blender: next });
        return next;
    };
    const write = async () => {
        if (active.has(key)) return;
        if (!link.pending && (!input || !destination || !status?.sessionId || refreshing)) return;
        active.add(key); setWorking(true);
        ctx.updateMetadata({ errorDetails: undefined });
        try {
            let pending = link.pending;
            let metadata = ctx.getNode(ctx.node.id)?.metadata;
            if (!pending && input && destination && status?.sessionId) {
                const dataUrl = await asPng(await imageToDataUrl({ storageKey: input.storageKey, url: input.url }));
                const frozen = await uploadImage(await (await fetch(dataUrl)).blob());
                if (!frozen.storageKey) throw new Error("无法保存待写回原图。");
                pending = { commandId: crypto.randomUUID(), sessionId: status.sessionId, port: status.port, destination, colorSpace: link.colorSpace || "sRGB", storageKey: frozen.storageKey, inputKey: input.key };
                metadata = { ...imageMetadata(frozen), status: "loading", blender: { ...link, pending, receipt: undefined, writtenInputKey: undefined } };
                // Persist the exact command before submitting it. A lost response can only
                // be retried with the same image, target and command, including after reload.
                await ctx.storage.set(storageKey, metadata);
                ctx.updateMetadata(metadata);
            }
            if (!pending) return;
            const dataUrl = await imageToDataUrl({ storageKey: pending.storageKey });
            const receipt = await writeBlenderTexture(pending, dataUrl.replace(/^data:image\/png;base64,/, ""));
            const completed: CanvasNodeMetadata = { ...metadata, status: "success", errorDetails: undefined, blender: { ...link, pending: undefined, receipt, writtenInputKey: pending.inputKey } };
            await ctx.storage.remove(storageKey);
            if (ctx.getNode(ctx.node.id)) ctx.updateMetadata(completed);
            await refresh();
        } catch (error) { ctx.updateMetadata({ status: "error", errorDetails: textOf(error) }); }
        finally { active.delete(key); setWorking(false); }
    };
    return <div ref={panelRef} data-canvas-no-zoom className="flex min-h-0 flex-col text-sm" style={{ color: ctx.theme.node.text, maxHeight: `calc(100dvh - ${Math.max(12, panelRect?.top ?? 12)}px - 80px)` }}>
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: ctx.theme.node.stroke }}><span className="font-medium">Blender Link · {link.mode === "read" ? "读取" : "写回"}</span><button type="button" aria-label="关闭控制面板" className={buttonClass} onClick={onClose}><X className="size-4" /></button></header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="flex items-end gap-2"><label className="min-w-0 flex-1 space-y-1.5"><span className="block">BlenderMCP 端口</span><input type="number" min={1} max={65535} step={1} aria-label="BlenderMCP 端口" className={fieldClass} style={controlStyle} value={portDraft} disabled={locked} onChange={event => setPortDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && validPort && !locked && !refreshing) { event.preventDefault(); void connect(); } }} /></label><button type="button" className={`${buttonClass} shrink-0`} disabled={!validPort || locked || refreshing} onClick={() => void connect()}>{savingConnection ? "保存中…" : "连接"}</button></div>
            <p className="text-xs opacity-60">127.0.0.1:{status?.port ?? connectionPort ?? "—"} · 本分支所有 Blender 节点共用</p>
            <div className="flex items-center justify-between gap-2"><span className="text-xs">{connected ? `Blender ${status.blenderVersion} 已连接` : refreshing ? "正在检查 BlenderMCP…" : "BlenderMCP 未连接"}</span><button className={buttonClass} disabled={refreshing || busy} onClick={() => void refresh()}>刷新</button></div>
            {connected ? <p className="break-words text-xs opacity-60">{status.fileName} · {status.sceneName}</p> : null}
            {connectionError || status?.error ? <p role="alert" className="break-words text-xs">{connectionError || status?.error}</p> : null}
            {connected && link.mode === "read" ? <>
                <label className="block space-y-1.5"><span>选择视口</span><select aria-label="Blender 选择视口" className={fieldClass} style={controlStyle} value={source?.id || ""} disabled={locked} onChange={event => { const next = patch({ sourceId: event.target.value, sessionId: status.sessionId }); void captureBlenderRead(ctx, next); }}><option value="" disabled hidden>请选择视口或渲染结果</option>{!status.sources.length ? <option disabled>没有可读取的视口或渲染结果</option> : null}{status.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                {source ? <p className="text-xs leading-5 opacity-60">{source.kind === "render" ? "读取最近一次渲染结果，不重新渲染。" : "读取所选视口当前视角与着色效果。"}选择后自动更新画面，也可点击节点右下角的刷新图标再次读取。</p> : null}
            </> : null}
            {connected && link.mode === "write" ? <>
                <label className="block space-y-1.5"><span>写回方式</span><select aria-label="Blender 写回方式" className={fieldClass} style={controlStyle} value={writeMode} disabled={locked} onChange={event => patch({ writeMode: event.target.value as BlenderDestination["kind"], sessionId: status.sessionId })}><option value="image">更新已有贴图</option><option value="new">新建图片</option><option value="node">替换材质节点</option></select></label>
                {writeMode === "image" ? <>
                    <label className="block space-y-1.5"><span>目标贴图</span><select aria-label="Blender 目标贴图" className={fieldClass} style={controlStyle} value={image?.id || ""} disabled={locked} onChange={event => { const selected = status.images.find(item => item.id === event.target.value); patch({ imageId: event.target.value, sessionId: status.sessionId, colorSpace: selected?.colorSpace === "Non-Color" ? "Non-Color" : "sRGB" }); }}><option value="" disabled hidden>请选择贴图</option>{!status.images.length ? <option disabled>没有可写入的图片</option> : null}{status.images.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    {image ? <div className="flex items-center gap-3 text-xs opacity-75">{preview ? <img src={`data:image/png;base64,${preview.imageBase64}`} alt={`目标贴图：${image.name}`} className="size-20 shrink-0 rounded object-contain" /> : <p>{previewError || "正在读取贴图预览…"}</p>}<p>{preview?.width ?? image.width} × {preview?.height ?? image.height}<br />{image.users} 处引用</p></div> : null}
                    <p className="text-xs leading-5 opacity-60">直接覆盖所选贴图，引用它的材质一起更新。</p>
                </> : writeMode === "new" ? <>
                    <label className="block space-y-1.5"><span>图片名称</span><input aria-label="Blender 新图片名称" className={fieldClass} style={controlStyle} value={link.imageName ?? "Canvas Result"} disabled={locked} onChange={event => patch({ imageName: event.target.value })} /></label>
                    <p className="text-xs leading-5 opacity-60">将结果加入工程图片列表，之后可在 Blender 中选用；不自动分配材质。</p>
                </> : <>
                    <label className="block space-y-1.5"><span>目标材质</span><select aria-label="Blender 目标材质" className={fieldClass} style={controlStyle} value={material?.materialId || ""} disabled={locked} onChange={event => patch({ materialId: event.target.value, targetId: undefined, sessionId: status.sessionId })}><option value="" disabled hidden>请选择材质</option>{!materials.length ? <option disabled>没有可写入的图像纹理节点</option> : null}{materials.map(item => <option key={item.materialId} value={item.materialId}>{item.materialName}</option>)}</select></label>
                    {material ? <label className="block space-y-1.5"><span>图像纹理节点</span><select aria-label="Blender 图像纹理节点" className={fieldClass} style={controlStyle} value={target?.id || ""} disabled={locked} onChange={event => patch({ targetId: event.target.value })}><option value="" disabled hidden>请选择图像纹理节点</option>{status.targets.filter(item => item.materialId === material.materialId).map(item => <option key={item.id} value={item.id}>{item.nodeName} · {item.imageName || "空图片"}</option>)}</select></label> : null}
                    <p className="text-xs leading-5 opacity-60">新建结果图片，替换指定节点的引用；原贴图保留。共享此材质的对象都会更新。</p>
                </>}
                {destination ? <>
                    <label className="block space-y-1.5"><span>贴图色彩用途</span><select aria-label="贴图色彩用途" className={fieldClass} style={controlStyle} value={link.colorSpace || "sRGB"} disabled={locked} onChange={event => patch({ colorSpace: event.target.value as "sRGB" | "Non-Color" })}><option value="sRGB">颜色（sRGB）</option><option value="Non-Color">数据（Non-Color）</option></select></label>
                    <p className="text-xs leading-5 opacity-60">按输入图片尺寸写入。保存 .blend 后保留，磁盘原文件不变。</p>
                    {!link.pending ? <button className={`${buttonClass} w-full`} disabled={busy || refreshing || !input || link.writtenInputKey === input.key} onClick={() => void write()}>{busy ? "正在写回…" : input && link.writtenInputKey === input.key ? "当前图片已写回" : writeMode === "new" ? "新建并写入" : "写回当前图片"}</button> : null}
                </> : null}
                {!link.pending && !input ? <p className="text-xs opacity-60">连接一张已完成的图片；多张输入时请只保留一条有效连线。</p> : null}
            </> : null}
            {link.mode === "write" && link.pending ? <div className="space-y-2 text-xs"><p>有一条待确认写回，端口 {link.pending.port}；重试会使用冻结的原图和原目标。放弃前请先检查 Blender 中是否已经写入。</p><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void write()}>查询／重试同一指令</button><button className={buttonClass} disabled={busy} onClick={() => void ctx.storage.remove(storageKey).then(() => ctx.updateMetadata({ ...emptyPreview, blender: { ...link, pending: undefined, receipt: undefined, writtenInputKey: undefined } })).catch(error => ctx.updateMetadata({ errorDetails: textOf(error) }))}>放弃待确认写回</button></div></div> : null}
            {ctx.node.metadata?.errorDetails ? <p role="alert" className="break-words text-xs leading-5">{ctx.node.metadata.errorDetails}</p> : null}
            {link.snapshot && link.mode === "read" ? <p className="break-words text-xs opacity-60">已读取：{link.snapshot.sourceName} · {link.snapshot.width} × {link.snapshot.height}</p> : null}
            {link.receipt && link.mode === "write" ? <p className="break-words text-xs opacity-60">已写回：{link.receipt.imageName}</p> : null}
        </div>
    </div>;
}

let registered = false;
export function registerLocalBlenderNodes() {
    if (import.meta.env.VITE_LOCAL_SHARED_STORAGE !== "1" || registered) return;
    registered = true;
    registerNodeDefinitions([{ type: BLENDER_LINK, title: "Blender Link", icon: <img src="/icons/blender.svg" alt="" className="size-4" />, description: "读取 Blender 视口／渲染图，更新或新建工程贴图", defaultSize: { width: 360, height: 360 }, defaultMetadata: { blender: { mode: "read", writeMode: "image", colorSpace: "sRGB" } }, hasSourceHandle: true, hasTargetHandle: node => node.metadata?.blender?.mode === "write", keepAspectRatio: () => true, Content: LinkContent, Panel: LinkPanel,
        resource: node => node.metadata?.content && (node.metadata.blender?.mode === "read" || hasBlenderWriteOutput(node)) ? { kind: "image", url: node.metadata.content } : null,
    }], "local-blender-link");
}
