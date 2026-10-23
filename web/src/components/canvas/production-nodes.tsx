import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";
import { useRef, useState } from "react";
import { BookImage, Download, FolderOpen, Save, X } from "lucide-react";
import { saveAs } from "file-saver";
import { useAssetStore, type TextAsset } from "@/stores/use-asset-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { REFERENCE_PACK, EXPORT_PRESET, PACK_SOURCE, EXPORT_SOURCE, EMPTY_PACK, DEFAULT_EXPORT, referencePackText } from "@/lib/canvas/canvas-production";
import { preparePresetExport, presetZip, safeExportName, validateExportPreset, writeExportDirectory, type ExportDirectoryHandle } from "@/lib/canvas/export-preset";
import type { ReferencePack, ExportPreset } from "@/types/canvas-production";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

const button = "inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
const field = "w-full min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none";
function packRevisions(asset?: TextAsset): ReferencePack[] { return (asset?.metadata?.referencePackRevisions as ReferencePack[] | undefined) || []; }
async function restorePack(pack: ReferencePack): Promise<ReferencePack> {
    return { ...pack, images: await Promise.all(pack.images.map(async image => ({ ...image, content: await resolveImageUrl(image.storageKey, image.content) }))) };
}

function PackContent({ ctx }: { ctx: CanvasNodeContext }) {
    const pack = ctx.node.metadata?.referencePack || EMPTY_PACK;
    return <div className="flex h-full w-full flex-col gap-3 overflow-hidden rounded-[inherit] p-4" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text }}>
        <div className="flex items-center gap-2"><BookImage size={18} /><strong className="min-w-0 flex-1 truncate text-sm">{pack.name || "风格 / 角色参考包"}</strong><span className="text-xs" style={{ color: ctx.theme.node.muted }}>{pack.version ? `v${pack.version}` : "草稿"}</span></div>
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-1.5">{pack.images.slice(0, 3).map(image => <img key={image.id} src={image.content} alt={image.title} draggable={false} className="pointer-events-none h-full min-h-0 w-full rounded-lg object-cover" />)}{!pack.images.length ? <p className="col-span-3 self-center text-center text-xs" style={{ color: ctx.theme.node.muted }}>点击编辑规则、收集参考或载入已存版本</p> : null}</div>
        <p className="line-clamp-2 text-xs leading-5" style={{ color: ctx.theme.node.muted }}>{pack.rules || "添加应保持的风格、识别特征与禁止事项"}</p>
        <span className="text-[11px]" style={{ color: ctx.theme.node.muted }}>{pack.kind === "character" ? "角色" : "风格"} · {pack.images.length} 张参考</span>
    </div>;
}

function PackPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const panelRect = useCanvasPopoverAnchor(panelRef, true);
    const pack = ctx.node.metadata?.referencePack || EMPTY_PACK;
    const assets = useAssetStore(state => state.assets);
    const library = assets.filter((asset): asset is TextAsset => asset.kind === "text" && asset.source === PACK_SOURCE);
    const asset = library.find(asset => asset.id === pack.assetId);
    const revisions = packRevisions(asset);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const inputStyle = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    const patch = (value: Partial<ReferencePack>) => ctx.updateMetadata({ referencePack: { ...pack, ...value, version: 0 } });
    const load = async (snapshot: ReferencePack, assetId: string) => {
        setBusy(true);
        try { const restored = await restorePack(snapshot); ctx.updateMetadata({ referencePack: { ...restored, assetId } }); setNotice(`已引用 ${restored.name} v${restored.version}；其他节点不会随草稿修改。`); }
        catch (error) { setNotice(error instanceof Error ? error.message : "参考包载入失败"); }
        finally { setBusy(false); }
    };
    const capture = async () => {
        const inputs = ctx.node.metadata?.productionInputs || [];
        if (!inputs.length || inputs.some(image => !image.content)) return setNotice("请连接已就绪的图片，再收集参考。");
        setBusy(true);
        try {
            const images = await Promise.all(inputs.map(async image => {
                if (image.storageKey) return { ...image };
                const saved = await uploadImage(image.content!);
                if (!saved.storageKey) throw new Error(`无法保存「${image.title}」的原图，请先将它导入画布。`);
                return { ...image, content: saved.url, storageKey: saved.storageKey, naturalWidth: saved.width, naturalHeight: saved.height, mimeType: saved.mimeType, bytes: saved.bytes };
            }));
            patch({ images });
            setNotice("已保存参考快照；后续来源变化不会修改此快照。");
        } catch (error) { setNotice(error instanceof Error ? error.message : "参考收集失败"); }
        finally { setBusy(false); }
    };
    const save = (asNew: boolean) => {
        if (!pack.name.trim()) return setNotice("请填写参考包名称。");
        if (!pack.rules.trim() && !pack.images.length) return setNotice("请添加规则或参考图片。");
        const current = !asNew && asset;
        const history = current ? packRevisions(current) : [];
        const snapshot = { ...pack, name: pack.name.trim(), assetId: undefined, version: Math.max(0, ...history.map(item => item.version)) + 1 };
        const store = useAssetStore.getState();
        const data = { content: referencePackText(snapshot) };
        let assetId: string;
        if (current) { assetId = current.id; store.updateAsset(assetId, { title: snapshot.name, data, metadata: { ...current.metadata, referencePackRevisions: [...history, snapshot] } }); }
        else assetId = store.addAsset({ kind: "text", title: snapshot.name, coverUrl: "", tags: ["参考包", snapshot.kind === "style" ? "风格" : "角色"], source: PACK_SOURCE, data, metadata: { referencePackRevisions: [snapshot] } });
        ctx.updateMetadata({ referencePack: { ...snapshot, assetId } });
        setNotice(`已保存 v${snapshot.version}，可在其他参考包节点载入。已有引用保持原版本。`);
    };
    return <div ref={panelRef} data-reference-pack-panel className="mx-auto space-y-3 overflow-y-auto rounded-2xl border p-4" style={{ width: "min(600px, calc(100vw - 320px))", maxHeight: `max(160px, calc(100dvh - ${Math.max(12, panelRect?.top ?? 12)}px - 80px))`, background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }} data-canvas-no-zoom>
        <div className="flex items-center gap-2"><BookImage size={16} /><strong className="flex-1 text-sm">风格 / 角色参考包</strong><button className={button} aria-label="关闭参考包面板" onClick={onClose}><X size={16} /></button></div>
        <div className="grid grid-cols-[1fr_100px] gap-2">
            <select className={field} style={inputStyle} aria-label="参考包库" disabled={busy} value={asset?.id || ""} onChange={event => { const selected = library.find(asset => asset.id === event.target.value); const latest = packRevisions(selected).at(-1); if (selected && latest) void load(latest, selected.id); }}><option value="" disabled hidden>选择已保存的参考包</option>{library.map(asset => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select>
            <select className={field} style={inputStyle} aria-label="参考包版本" disabled={busy || !revisions.length} value={revisions.some(item => item.version === pack.version) ? pack.version : ""} onChange={event => { const snapshot = revisions.find(item => item.version === Number(event.target.value)); if (snapshot && asset) void load(snapshot, asset.id); }}><option value="" disabled hidden>草稿</option>{revisions.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}</select>
        </div>
        <div className="grid grid-cols-[1fr_100px] gap-2"><input className={field} style={inputStyle} aria-label="参考包名称" disabled={busy} placeholder="例如：沙漠地区 · 美术规范" value={pack.name} onChange={event => patch({ name: event.target.value })} /><select className={field} style={inputStyle} aria-label="参考包类型" disabled={busy} value={pack.kind} onChange={event => patch({ kind: event.target.value as ReferencePack["kind"] })}><option value="style">风格</option><option value="character">角色</option></select></div>
        <textarea className={`${field} min-h-24 resize-y`} style={inputStyle} aria-label="参考包规则" disabled={busy} placeholder="色板、材质、轮廓、不可改变的特征、禁止事项……" value={pack.rules} onChange={event => patch({ rules: event.target.value })} />
        <div className="flex items-center justify-between"><span className="text-xs">参考图片 · {pack.images.length}</span><button className={button} disabled={busy} onClick={() => void capture()}>收集已连接图片</button></div>
        <div className="flex max-h-36 flex-wrap gap-2 overflow-auto">{pack.images.map(image => <div key={image.id} className="relative w-24"><img src={image.content} alt={image.title} className="h-16 w-24 rounded object-contain" /><button className={`${button} w-full`} aria-label={`移除参考：${image.title}`} disabled={busy} onClick={() => patch({ images: pack.images.filter(item => item.id !== image.id) })}>移除</button></div>)}</div>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => save(false)}><Save size={14} />{asset ? "保存新版本" : "保存参考包"}</button>{asset ? <button className={button} disabled={busy} onClick={() => save(true)}>另存为新参考包</button> : null}</div>
        <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>右侧连接生成配置后，规则和全部参考图会一起加入生成上下文。草稿仅影响当前节点；保存新版本后，其他节点可手动切换版本。</p>
        {notice ? <p role="status" className="text-xs leading-5">{notice}</p> : null}
    </div>;
}

function ExportContent({ ctx }: { ctx: CanvasNodeContext }) {
    const preset = ctx.node.metadata?.exportPreset || DEFAULT_EXPORT;
    return <div className="flex h-full w-full flex-col justify-center gap-3 rounded-[inherit] p-5" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text }}><Download size={24} /><strong className="text-sm">{preset.name || "导出预设"}</strong><span className="text-xs" style={{ color: ctx.theme.node.muted }}>{preset.width} × {preset.height} · {preset.format.toUpperCase()} · {ctx.node.metadata?.productionInputs?.length || 0} 张输入</span><span className="text-xs" style={{ color: ctx.theme.node.muted }}>{preset.directory || "根目录"} / {preset.pattern}</span></div>;
}

function ExportPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const panelRect = useCanvasPopoverAnchor(panelRef, true);
    const preset = ctx.node.metadata?.exportPreset || DEFAULT_EXPORT;
    const assets = useAssetStore(state => state.assets);
    const library = assets.filter((asset): asset is TextAsset => asset.kind === "text" && asset.source === EXPORT_SOURCE);
    const [presetId, setPresetId] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const controller = useRef<AbortController | null>(null);
    const inputStyle = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    const patch = (value: Partial<ExportPreset>) => ctx.updateMetadata({ exportPreset: { ...preset, ...value } });
    const save = () => {
        try {
            validateExportPreset(preset);
            if (!preset.name.trim()) throw new Error("请填写预设名称。");
            const store = useAssetStore.getState();
            const data = { content: `${preset.width} × ${preset.height} ${preset.format}` };
            const existing = library.find(asset => asset.id === presetId);
            if (existing) store.updateAsset(existing.id, { title: preset.name, data, metadata: { exportPreset: preset } });
            else setPresetId(store.addAsset({ kind: "text", title: preset.name, coverUrl: "", tags: ["导出预设"], source: EXPORT_SOURCE, data, metadata: { exportPreset: preset } }));
            setNotice("预设已保存，可在其他导出节点载入。");
        } catch (error) { setNotice(error instanceof Error ? error.message : "预设保存失败"); }
    };
    const run = async (directory: boolean) => {
        if (busy) return;
        setBusy(true);
        const abort = new AbortController(); controller.current = abort;
        try {
            validateExportPreset(preset);
            const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<ExportDirectoryHandle> }).showDirectoryPicker;
            if (directory && !picker) throw new Error("此浏览器不支持目录选择，请使用 ZIP 导出。");
            const root = directory ? await picker!.call(window, { mode: "readwrite" }) : null;
            setNotice("正在按当前来源快照处理图片……");
            const files = await preparePresetExport(ctx.node.metadata?.productionInputs || [], { ...preset }, abort.signal);
            if (root) { const folder = await writeExportDirectory(root, files, abort.signal); setNotice(`已导出到所选目录下的 ${folder}。`); }
            else { const zip = await presetZip(files); abort.signal.throwIfAborted(); saveAs(zip, `${safeExportName(preset.name || "images")}.zip`); setNotice(`已生成 ZIP：${files.filter(file => !file.name.endsWith(".json")).length} 张图片${preset.metadata ? "及元数据清单" : ""}。`); }
        } catch (error) { setNotice(error instanceof DOMException && error.name === "AbortError" ? "已取消导出。" : error instanceof Error ? error.message : "导出失败"); }
        finally { setBusy(false); controller.current = null; }
    };
    return <div ref={panelRef} data-export-preset-panel className="mx-auto space-y-3 overflow-y-auto rounded-2xl border p-4" style={{ width: "min(600px, calc(100vw - 320px))", maxHeight: `max(160px, calc(100dvh - ${Math.max(12, panelRect?.top ?? 12)}px - 80px))`, background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }} data-canvas-no-zoom>
        <div className="flex items-center gap-2"><Download size={16} /><strong className="flex-1 text-sm">导出预设</strong><button className={button} aria-label="关闭导出面板" onClick={onClose}><X size={16} /></button></div>
        <select className={field} style={inputStyle} aria-label="导出预设库" value={library.some(asset => asset.id === presetId) ? presetId : ""} onChange={event => { const asset = library.find(item => item.id === event.target.value); if (asset?.metadata?.exportPreset) { ctx.updateMetadata({ exportPreset: asset.metadata.exportPreset as ExportPreset }); setPresetId(asset.id); } }}><option value="" disabled hidden>载入已保存的导出预设</option>{library.map(asset => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select>
        <input className={field} style={inputStyle} aria-label="导出预设名称" value={preset.name} onChange={event => patch({ name: event.target.value })} />
        <div className="grid grid-cols-3 gap-2"><label className="text-xs">宽度<input type="number" className={field} style={inputStyle} aria-label="导出宽度" value={preset.width} onChange={event => patch({ width: Number(event.target.value) })} /></label><label className="text-xs">高度<input type="number" className={field} style={inputStyle} aria-label="导出高度" value={preset.height} onChange={event => patch({ height: Number(event.target.value) })} /></label><label className="text-xs">格式<select className={field} style={inputStyle} aria-label="导出格式" value={preset.format} onChange={event => patch({ format: event.target.value as ExportPreset["format"], ...(event.target.value === "jpeg" ? { transparent: false } : {}) })}><option value="png">PNG</option><option value="webp">WebP</option><option value="jpeg">JPEG</option></select></label></div>
        <div className="flex flex-wrap items-center gap-3 text-xs"><select className={`${field} !w-auto`} style={inputStyle} aria-label="导出适应方式" value={preset.fit} onChange={event => patch({ fit: event.target.value as ExportPreset["fit"] })}><option value="contain">等比完整显示，留白</option><option value="cover">等比铺满，裁边</option></select><label className="flex items-center gap-1"><input type="checkbox" checked={preset.transparent} disabled={preset.format === "jpeg"} onChange={event => patch({ transparent: event.target.checked })} />透明背景</label>{!preset.transparent ? <label className="flex items-center gap-1">底色<input type="color" aria-label="导出底色" value={preset.background} onChange={event => patch({ background: event.target.value })} /></label> : null}</div>
        <label className="block text-xs">命名模板<input className={field} style={inputStyle} aria-label="导出命名模板" value={preset.pattern} onChange={event => patch({ pattern: event.target.value })} /></label>
        <p className="text-[11px]" style={{ color: ctx.theme.node.muted }}>{"可用：{name}、{index}、{width}、{height}。同名自动加序号。"}</p>
        <label className="block text-xs">导出子目录<input className={field} style={inputStyle} aria-label="导出子目录" value={preset.directory} onChange={event => patch({ directory: event.target.value })} /></label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={preset.metadata} onChange={event => patch({ metadata: event.target.checked })} />附带 manifest.json：尺寸、格式、来源与预设</label>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={save}><Save size={14} />保存导出预设</button><button className={button} disabled={busy} onClick={() => void run(false)}><Download size={14} />下载 ZIP</button><button className={button} disabled={busy} onClick={() => void run(true)}><FolderOpen size={14} />选择目录导出</button>{busy ? <button className={button} onClick={() => controller.current?.abort()}>取消</button> : null}</div>
        <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>透明只保留原图 Alpha 和留白，不会自动抠图。目录导出新建独立文件夹；ZIP 保留子目录。仅导出当前选定图，不修改原图。</p>
        {notice ? <p role="status" className="text-xs leading-5">{notice}</p> : null}
    </div>;
}

export function registerProductionNodes() {
    registerNodeDefinitions([
        { type: REFERENCE_PACK, title: "风格 / 角色参考包", icon: <BookImage size={16} />, description: "可复用的参考集合、规则与版本", defaultSize: { width: 340, height: 260 }, defaultMetadata: { referencePack: EMPTY_PACK }, autoOpenPanel: true, Content: PackContent, Panel: PackPanel, resource: node => node.metadata?.referencePack ? { kind: "text", text: referencePackText(node.metadata.referencePack) } : null },
        { type: EXPORT_PRESET, title: "导出预设", icon: <Download size={16} />, description: "统一尺寸、格式、命名与交付目录", defaultSize: { width: 300, height: 200 }, defaultMetadata: { exportPreset: DEFAULT_EXPORT }, autoOpenPanel: true, hasSourceHandle: false, Content: ExportContent, Panel: ExportPanel },
    ], "production");
}
