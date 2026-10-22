import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, Brush, Settings2, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { KRITA_PRESET, KRITA_SOURCE, followKritaGeneration, isKritaNodeBusy, patchKritaPreset, stopKritaWaiting, submitConfiguredKritaGeneration, submitKritaGeneration } from "@/lib/canvas/krita-link";
import { createKritaSnapshot, getKritaImage, getKritaPresets, getKritaStatus, listKritaGenerations, returnKritaImage } from "@/services/api/krita-link";
import { uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeToolbarItem } from "@/types/canvas-plugin";
import type { KritaGeneration, KritaGenerationParams, KritaPresetCatalog, KritaPresetMetadata, KritaStatus } from "@/types/krita-link";

const enabled = import.meta.env.VITE_LOCAL_SHARED_STORAGE === "1";
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const fieldClass = "w-full rounded border px-2.5 py-2 text-sm outline-none focus:ring-1";
const textOf = (error: unknown) => error instanceof Error ? error.message : "本机绘画连接暂时不可用。";
const controlStyle = (ctx: CanvasNodeContext): CSSProperties => ({ background: ctx.theme.node.panel, color: ctx.theme.node.text, borderColor: ctx.theme.node.stroke });
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const jobLabel = { queued: "等待中", running: "生成中", succeeded: "已完成", failed: "失败" };

export const isKritaResultNode = (node: CanvasNodeData) => enabled && node.type === CanvasNodeType.Image && node.metadata?.krita?.kind === "result";
export const isKritaDockedNode = (node: CanvasNodeData) => enabled && (node.type === KRITA_SOURCE || node.type === KRITA_PRESET || isKritaResultNode(node));

function PanelFrame({ ctx, title, onClose, children }: { ctx: CanvasNodeContext; title: string; onClose: () => void; children: ReactNode }) {
    return <div data-canvas-no-zoom className="flex h-full min-h-0 flex-col text-sm" style={{ color: ctx.theme.node.text }}>
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: ctx.theme.node.stroke }}><div className="min-w-0"><div className="font-medium">{title}</div><div className="mt-0.5 truncate text-xs opacity-60">{ctx.node.title}</div></div><button type="button" className={buttonClass} aria-label="关闭控制面板" onClick={onClose}><X className="size-4" /></button></header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
    </div>;
}

function SourceContent({ ctx }: { ctx: CanvasNodeContext }) {
    const snapshot = ctx.node.metadata?.krita?.kind === "source" ? ctx.node.metadata.krita.snapshot : undefined;
    return <div className="flex h-full flex-col gap-2 p-3" style={{ color: ctx.theme.node.text }}>
        {snapshot && ctx.node.metadata?.content ? <img src={ctx.node.metadata.content} alt={`Krita 快照：${snapshot.documentName}`} draggable={false} className="min-h-0 flex-1 object-contain" /> : <div className="flex flex-1 items-center justify-center text-xs opacity-60">选中文档后，手动读取一次画面</div>}
        <div className="truncate text-xs">{snapshot ? `${snapshot.documentName} · ${snapshot.width} × ${snapshot.height}` : "Krita 输入"}</div>
        <div className="text-[11px] opacity-60">静态快照 · 拖出连线可建立多个分支</div>
    </div>;
}

function SourcePanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const source = ctx.node.metadata?.krita?.kind === "source" ? ctx.node.metadata.krita : { kind: "source" as const };
    const [status, setStatus] = useState<KritaStatus | null>(null);
    const [error, setError] = useState("");
    const [refreshing, setRefreshing] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const refresh = async (signal?: AbortSignal) => {
        setRefreshing(true); setError("");
        try { setStatus(await getKritaStatus(signal)); } catch (reason) { if (!isAbort(reason)) { setStatus(null); setError(textOf(reason)); } }
        finally { if (!signal?.aborted) setRefreshing(false); }
    };
    useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [ctx.node.id]);
    const document = status?.documents.find((item) => item.id === source.documentId);
    const bind = (documentId?: string, layerId?: string) => ctx.updateMetadata({ content: undefined, storageKey: undefined, status: "idle", errorDetails: undefined, krita: { kind: "source", documentId, ...(layerId ? { layerId } : {}) } });
    const capture = async () => {
        if (!document || capturing) return;
        setCapturing(true); setError("");
        try {
            const snapshot = await createKritaSnapshot(document.id, source.layerId);
            const image = await uploadImage(await getKritaImage(snapshot.imageUrl));
            const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
            if (current?.kind === "source" && current.documentId === document.id && current.layerId === source.layerId) ctx.updateMetadata({ ...imageMetadata(image), errorDetails: undefined, krita: { ...current, snapshot } });
        } catch (reason) { setError(textOf(reason)); } finally { setCapturing(false); }
    };
    const branch = () => {
        const id = `${KRITA_PRESET}-${crypto.randomUUID()}`;
        ctx.applyOps([{ type: "add_node", id, nodeType: KRITA_PRESET, x: ctx.node.position.x + ctx.node.width + 80, y: ctx.node.position.y, metadata: { krita: { kind: "preset", presetId: "draft" }, prompt: "" } }, { type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: id }]);
    };
    return <PanelFrame ctx={ctx} title="Krita 输入" onClose={onClose}>
        <div className="flex items-center justify-between gap-2"><span className="text-xs">{status?.connected ? "Krita 已连接" : "Krita 未连接"}</span><button className={buttonClass} disabled={refreshing || capturing} onClick={() => void refresh()}>{refreshing ? "正在读取…" : "刷新文档"}</button></div>
        {(error || status?.error) ? <p role="alert" className="break-words text-xs">{error || status?.error}</p> : null}
        <label className="block space-y-1.5"><span>绑定文档</span><select aria-label="绑定文档" className={fieldClass} style={controlStyle(ctx)} value={source.documentId || ""} disabled={capturing} onChange={(event) => bind(event.target.value || undefined)}><option value="">请选择文档</option>{source.documentId && !document ? <option value={source.documentId}>原绑定文档暂未打开</option> : null}{status?.documents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.width} × {item.height}</option>)}</select></label>
        <label className="block space-y-1.5"><span>读取范围</span><select aria-label="读取范围" className={fieldClass} style={controlStyle(ctx)} value={source.layerId || ""} disabled={!document || capturing} onChange={(event) => bind(source.documentId, event.target.value || undefined)}><option value="">完整画面（可见图层合成）</option>{source.layerId && !document?.layers.some((item) => item.id === source.layerId) ? <option value={source.layerId}>原图层暂不可用</option> : null}{document?.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <p className="text-xs leading-5 opacity-60">手动读取，不自动同步笔画。此版不读取选区，也不自动生成。切换活动文档不会改变这里的绑定。</p>
        <button className={`${buttonClass} w-full border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={!status?.connected || !document || capturing || (!!source.layerId && !document.layers.some((item) => item.id === source.layerId))} onClick={() => void capture()}>{capturing ? "正在保存快照…" : "读取当前画面"}</button>
        {source.snapshot ? <div className="space-y-1 break-words text-xs leading-5"><div>已读取：{source.snapshot.documentName}</div><div>{new Date(source.snapshot.createdAt).toLocaleString()} · {source.snapshot.width} × {source.snapshot.height}</div><div className="opacity-60">{source.snapshot.colorModel} / {source.snapshot.colorDepth} · {source.snapshot.colorProfile}</div><div className="opacity-60">快照 {source.snapshot.id.slice(0, 8)}；重新读取不会更改已提交任务。</div></div> : null}
        <button className={buttonClass} onClick={branch}>新建生成分支 →</button>
    </PanelFrame>;
}

function PresetContent({ ctx }: { ctx: CanvasNodeContext }) {
    const settings = ctx.node.metadata?.krita;
    const count = ctx.getUpstream().filter((node) => node.type === KRITA_SOURCE).length;
    return <div className="flex h-full flex-col justify-between gap-3 p-4" style={{ color: ctx.theme.node.text }}><div><div className="text-sm font-medium">{settings?.kind === "preset" && settings.presetId === "detail" ? "保守细化" : "草稿改绘"}</div><p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs opacity-75">{ctx.node.metadata?.prompt || "选中节点，在右侧填写提示词与参数"}</p></div><div className="text-[11px] opacity-60">Krita 输入 {count} 个 · 手动生成 · 每次新增结果</div></div>;
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
    const sources = upstream.filter((node) => node.type === KRITA_SOURCE);
    const snapshot = sources[0]?.metadata?.krita?.kind === "source" ? sources[0].metadata.krita.snapshot : undefined;
    const unsupportedImages = upstream.filter((node) => node.type === CanvasNodeType.Image || (node.type === KRITA_SOURCE && sources.length > 1));
    const textInputs = upstream.filter((node) => node.type === CanvasNodeType.Text).map((node) => node.metadata?.content || node.metadata?.prompt || "").filter(Boolean);
    const preset = catalog?.presets.find((item) => item.id === settings.presetId);
    const configuredModels = ctx.ai.listModels("image");
    const configuredModel = settings.configuredModel || ctx.ai.defaultModel("image");
    const modelAvailable = configured ? configuredModels.some((item) => item.value === configuredModel) : !!settings.model && !!catalog?.models.includes(settings.model);
    const params = { ...preset?.defaults, seed: -1, ...settings.params };
    const busy = isKritaNodeBusy(ctx.node.id);
    const supports = (key: string) => !preset?.supported || preset.supported.includes(key);
    const patch = (value: Partial<KritaPresetMetadata>) => patchKritaPreset(ctx, value);
    const setParam = (key: keyof KritaGenerationParams, value: string) => patch({ params: { ...settings.params, [key]: key === "sampler" || key === "scheduler" ? value : Number(value) } });
    const generate = () => {
        if (!snapshot || !modelAvailable || busy || (!configured && !preset)) return;
        const prompt = [...textInputs, ctx.node.metadata?.prompt || ""].filter(Boolean).join("\n\n").trim();
        if (!prompt) { setNotice("请填写提示词或连接文字节点。"); return; }
        setNotice("");
        if (configured) { void submitConfiguredKritaGeneration(ctx, snapshot, prompt, configuredModel); return; }
        void submitKritaGeneration(ctx, { snapshotId: snapshot.id, prompt, negativePrompt: settings.negativePrompt || "", model: settings.model!, presetId: preset!.id,
            params: { steps: Number(params.steps), cfg: Number(params.cfg), denoise: Number(params.denoise), seed: Number(params.seed), sampler: String(params.sampler || ""), scheduler: String(params.scheduler || "") } });
    };
    return <PanelFrame ctx={ctx} title="预设生成" onClose={onClose}>
        <div className="space-y-1 text-xs leading-5"><div>{snapshot ? `输入：${snapshot.documentName} · 快照 ${snapshot.id.slice(0, 8)}` : "请连接一个已读取画面的 Krita 输入节点。"}</div><div className="opacity-60">本次只使用一个草稿来源。风格/构图参考、多参考融合尚未接入；普通图片连线不会被悄悄当作参考。</div>{unsupportedImages.length ? <div role="alert">请断开额外图片或多余 Krita 输入后生成。</div> : null}{textInputs.length ? <div>连接文字 {textInputs.length} 个，会与下方提示词合并。</div> : null}</div>
        <label className="block space-y-1.5"><span>生成渠道</span><select aria-label="生成渠道" className={fieldClass} style={controlStyle(ctx)} value={configured ? "configured" : "comfy"} disabled={busy} onChange={(event) => patch({ backend: event.target.value === "configured" ? "configured" : "comfy" })}><option value="comfy">本机 ComfyUI</option><option value="configured">已配置生图渠道（含 Codex）</option></select></label>
        {!configured ? <>
        <label className="block space-y-1.5"><span>生成预设</span><select aria-label="生成预设" className={fieldClass} style={controlStyle(ctx)} value={settings.presetId} disabled={busy || !catalog} onChange={(event) => { const next = catalog?.presets.find((item) => item.id === event.target.value); if (next) { patch({ presetId: next.id, params: { ...next.defaults, seed: settings.params?.seed ?? -1 } }); setNotice("已使用该预设的默认参数；模型和提示词保持不变。"); } }}>{!catalog ? <option value={settings.presetId}>正在读取预设…</option> : catalog.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="block space-y-1.5"><span>本机模型</span><select aria-label="本机模型" className={fieldClass} style={controlStyle(ctx)} value={settings.model || ""} disabled={busy || !catalog?.available} onChange={(event) => patch({ model: event.target.value || undefined })}><option value="">请选择已有模型</option>{settings.model && !catalog?.models.includes(settings.model) ? <option value={settings.model}>{settings.model}（当前不可用）</option> : null}{catalog?.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
        </> : <><label className="block space-y-1.5"><span>渠道模型</span><select aria-label="渠道模型" className={fieldClass} style={controlStyle(ctx)} value={configuredModel} disabled={busy} onChange={(event) => patch({ configuredModel: event.target.value })}>{!configuredModel ? <option value="">请先配置生图模型</option> : !modelAvailable ? <option value={configuredModel}>{configuredModel}（当前不可用）</option> : null}{configuredModels.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label><p className="text-xs leading-5 opacity-60">沿用设置中的渠道、模型与参考图能力。仅发送提示词和这张源图；采样参数不适用于此渠道。请求尺寸为源画布尺寸，实际模型及输出尺寸以渠道结果为准，不保证指定 Image2 或精确尺寸。</p></>}
        <label className="block space-y-1.5"><span>提示词</span><textarea aria-label="提示词" rows={4} className={fieldClass} style={controlStyle(ctx)} value={ctx.node.metadata?.prompt || ""} onChange={(event) => ctx.updateMetadata({ prompt: event.target.value })} placeholder="描述希望在草稿基础上得到的结果" /></label>
        {!configured ? <><label className="block space-y-1.5"><span>反向提示词</span><textarea aria-label="反向提示词" rows={2} className={fieldClass} style={controlStyle(ctx)} value={settings.negativePrompt || ""} onChange={(event) => patch({ negativePrompt: event.target.value })} /></label>
        {supports("denoise") ? <label className="block space-y-1.5"><span>改绘强度</span><input aria-label="改绘强度" type="number" step="0.01" className={fieldClass} style={controlStyle(ctx)} value={params.denoise ?? ""} onChange={(event) => setParam("denoise", event.target.value)} /><span className="block text-xs opacity-60">越低越接近输入；按源快照生成，尺寸以实际输出为准。</span></label> : null}
        <details><summary className="cursor-pointer text-xs">高级参数</summary><div className="mt-3 grid grid-cols-2 gap-3">
            {([['steps', '采样步数'], ['cfg', '提示词强度'], ['seed', '种子（-1 随机）']] as const).filter(([key]) => supports(key)).map(([key, label]) => <label key={key} className="block space-y-1.5"><span className="text-xs">{label}</span><input aria-label={label} type="number" step={key === "cfg" ? "0.1" : "1"} className={fieldClass} style={controlStyle(ctx)} value={params[key] ?? ""} onChange={(event) => setParam(key, event.target.value)} /></label>)}
            {(['sampler', 'scheduler'] as const).filter(supports).map((key) => <label key={key} className="col-span-2 block space-y-1.5"><span className="text-xs">{key === "sampler" ? "采样器" : "调度方式"}</span><select aria-label={key === "sampler" ? "采样器" : "调度方式"} className={fieldClass} style={controlStyle(ctx)} value={params[key] || ""} onChange={(event) => setParam(key, event.target.value)}><option value="">请选择</option>{(key === "sampler" ? catalog?.samplers : catalog?.schedulers)?.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>)}
        </div></details>
        </> : null}
        {(loadError || (!configured && (presetError || catalog?.error)) || notice || ctx.node.metadata?.errorDetails) ? <p role="status" className="break-words text-xs leading-5">{notice || ctx.node.metadata?.errorDetails || loadError || (!configured && (presetError || catalog?.error))}</p> : null}
        <div className="flex gap-2"><button className={`${buttonClass} flex-1 border`} style={{ borderColor: ctx.theme.node.stroke }} disabled={busy || (!configured && !catalog?.available) || !modelAvailable || sources.length !== 1 || !snapshot || unsupportedImages.length > 0} onClick={generate}>{busy ? "正在等待结果…" : "手动生成新结果"}</button>{busy && !configured && settings.generationId ? <button className={buttonClass} onClick={() => stopKritaWaiting(ctx.node.id)}>停止等待</button> : null}</div>
        <p className="text-xs leading-5 opacity-60">提交时保存输入与实际参数；重新读取或继续绘画不会改动该任务。停止等待、刷新或等待超时后，后台可能继续；不会自动重试生成。</p>
        {configured ? <p className="text-xs leading-5 opacity-60">配置渠道完成后才写入本机任务记录。等待期间请保留页面；若刷新或关闭，请先检查该渠道自己的记录，勿直接重复生成。</p> : null}
        <section className="space-y-2 border-t pt-3" style={{ borderColor: ctx.theme.node.stroke }}><div className="flex items-center justify-between"><span className="font-medium">任务记录</span><button className={buttonClass} disabled={historyBusy} onClick={() => void refreshHistory()}>{historyBusy ? "读取中…" : "刷新记录"}</button></div>
            {settings.generationId ? <div className="flex items-center justify-between gap-2 text-xs"><span className="truncate">上次任务 {settings.generationId.slice(0, 8)}</span><button className={buttonClass} disabled={busy} onClick={() => void followKritaGeneration(ctx, settings.generationId!)}>查看 / 继续等待</button></div> : null}
            <div className="max-h-64 space-y-2 overflow-y-auto">{records.map((job) => <div key={job.id} className="border-t pt-2 text-xs" style={{ borderColor: ctx.theme.node.stroke }}><div className="flex items-center justify-between gap-2"><span className="truncate">{job.request.documentName || "原绑定文档"} · {jobLabel[job.status]}</span><button className={buttonClass} disabled={busy} onClick={() => void followKritaGeneration(ctx, job.id)}>{job.status === "succeeded" ? "加入结果" : "查看任务"}</button></div><div className="mt-1 truncate opacity-60">{job.id.slice(0, 8)} · {job.request.prompt}</div>{job.error ? <div className="mt-1 break-words">{job.error}</div> : null}</div>)}</div>
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
        <div className="text-xs leading-5"><div>任务 {result.generationId.slice(0, 8)} · 快照 {result.snapshotId.slice(0, 8)}</div><div className="break-words">模型：{result.request.model}</div>{result.request.backend !== "configured" ? <><div>步数 {result.request.params.steps} · 强度 {result.request.params.cfg} · 改绘 {result.request.params.denoise}</div><div>种子 {result.request.params.seed}</div></> : <div>已配置渠道；不应用 ComfyUI 采样参数。</div>}<div>原始结果 {result.imageWidth} × {result.imageHeight}{targetWidth && targetHeight ? ` · 原画布 ${targetWidth} × ${targetHeight}` : ""}</div></div>
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
    if (!enabled || registered) return;
    registered = true;
    registerNodeDefinitions([
        { type: KRITA_SOURCE, title: "Krita 输入", icon: <Brush className="size-4" />, description: "手动读取绑定文档的完整画面或图层", defaultSize: { width: 320, height: 250 }, defaultMetadata: { krita: { kind: "source" } }, autoOpenPanel: true, panelPlacement: "right", keepAspectRatio: () => true, Content: SourceContent, Panel: SourcePanel, resource: (node) => node.metadata?.content ? { kind: "image", url: node.metadata.content } : null },
        { type: KRITA_PRESET, title: "Krita 预设生成", icon: <Settings2 className="size-4" />, description: "连接一个输入与文字，手动提交生成", defaultSize: { width: 300, height: 210 }, defaultMetadata: { prompt: "", krita: { kind: "preset", presetId: "draft" } }, autoOpenPanel: true, panelPlacement: "right", Content: PresetContent, Panel: PresetPanel },
    ], "local-krita-link");
}
