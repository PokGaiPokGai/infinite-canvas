import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Eye, Pencil, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { DEFAULT_MASK_PREVIEW_COLOR, getPaintMaskSource, MASK_PAINT, paintMaskMatches, paintMaskPng, paintMaskSourceKey } from "@/lib/canvas/paint-mask";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { getSharedStorageStatus } from "@/lib/shared-storage";
import { PaintMaskEditor, PaintMaskStrokes } from "./paint-mask-editor";
import { processButton } from "./processing-panel";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { PaintMaskDrawing } from "@/types/paint-mask";

const editEvent = "paint-mask:edit", previewEvent = "paint-mask:preview";
const eventFor = (ctx: CanvasNodeContext) => ({ nodeId: ctx.node.id, projectId: ctx.projectId });

function PaintMaskContent({ ctx }: { ctx: CanvasNodeContext }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState<PaintMaskDrawing | null>(null);
    const [previewMask, setPreviewMask] = useState(false);
    const [loaded, setLoaded] = useState({ key: "", width: 0, height: 0 });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const request = useRef<AbortController | null>(null);
    const source = getPaintMaskSource(ctx.node);
    const sourceKey = source?.content ? paintMaskSourceKey(source) : "";
    const drawing = paintMaskMatches(ctx.node.metadata?.paintMask, source) ? ctx.node.metadata!.paintMask : undefined;
    const showingMask = previewMask && !!drawing && !!ctx.node.metadata?.content;
    const size = loaded.key === sourceKey ? loaded : { width: 0, height: 0 };
    const cancel = () => { request.current?.abort(); request.current = null; setDraft(null); setSaving(false); setError(""); };
    const start = () => {
        if (!source?.content || !size.width || !size.height) { ctx.openPanel(); return; }
        ctx.closePanel(); setPreviewMask(false); setError("");
        setDraft(drawing ? structuredClone(drawing) : { sourceId: source.id, sourceKey, width: size.width, height: size.height, strokes: [] });
    };
    const latest = useRef({ ctx, start });
    useLayoutEffect(() => { latest.current = { ctx, start }; });
    useEffect(() => {
        const matches = (payload: unknown) => {
            const value = payload as ReturnType<typeof eventFor> | undefined;
            return value?.nodeId === ctx.node.id && value.projectId === ctx.projectId;
        };
        const edit = ctx.on(editEvent, payload => { if (matches(payload)) latest.current.start(); });
        const preview = ctx.on(previewEvent, payload => { if (matches(payload)) setPreviewMask(value => !value); });
        return () => { edit(); preview(); request.current?.abort(); };
    }, [ctx.node.id, ctx.projectId]);

    const save = async (next: PaintMaskDrawing) => {
        if (request.current) return;
        const storage = getSharedStorageStatus();
        if (storage.remoteChanged || storage.error) { setError(storage.error || "其他窗口已更新画布，请先重新载入。"); return; }
        const ctx = latest.current.ctx;
        if (!paintMaskMatches(next, getPaintMaskSource(ctx.node))) { setError("原图或连线已变化，请取消后重新绘制。"); return; }
        const previous = ctx.node.metadata?.paintMask;
        if (previous?.output?.storageKey && paintMaskMatches(previous, getPaintMaskSource(ctx.node)) && JSON.stringify(previous.strokes) === JSON.stringify(next.strokes)) {
            ctx.updateMetadata({ paintMask: { ...structuredClone(next), output: previous.output } });
            setDraft(null);
            return;
        }
        const controller = new AbortController();
        request.current = controller; setSaving(true); setError("");
        let orphan: string | undefined;
        try {
            const image = await uploadImage(await paintMaskPng(next, controller.signal), { signal: controller.signal });
            orphan = image.storageKey;
            controller.signal.throwIfAborted();
            const current = latest.current.ctx;
            if (!paintMaskMatches(next, getPaintMaskSource(current.node))) throw new Error("原图或连线已变化，请取消后重新绘制。");
            const status = getSharedStorageStatus();
            if (status.remoteChanged || status.error) throw new Error(status.error || "其他窗口已更新画布，请先重新载入。");
            const output = { content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, mimeType: image.mimeType, bytes: image.bytes };
            current.updateMetadata({ ...imageMetadata(image), outputKind: "image", paintMask: { ...structuredClone(next), output }, errorDetails: undefined });
            orphan = undefined;
            setDraft(null);
        } catch (reason) {
            if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "蒙版保存失败。");
        } finally {
            if (orphan) await deleteStoredImages([orphan]);
            if (request.current === controller) { request.current = null; setSaving(false); }
        }
    };

    return <div ref={hostRef} className="relative h-full w-full overflow-hidden rounded-[inherit]" data-paint-mask-node>
        {source?.content ? <>
            <img src={showingMask ? ctx.node.metadata!.content : source.content} alt={showingMask ? "黑白蒙版" : `蒙版原图：${source.title}`} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-fill" onLoad={event => {
                if (showingMask) return;
                const image = event.currentTarget;
                setLoaded({ key: sourceKey, width: image.naturalWidth, height: image.naturalHeight });
                const height = ctx.node.width * image.naturalHeight / image.naturalWidth;
                if (Math.abs(ctx.node.height - height) > 1) ctx.updateNode({ height });
            }} />
            {!showingMask && drawing ? <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${drawing.width} ${drawing.height}`} aria-hidden="true"><PaintMaskStrokes strokes={drawing.strokes} color={drawing.previewColor ?? DEFAULT_MASK_PREVIEW_COLOR} /></svg> : null}
        </> : <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-canvas-ui" style={{ color: ctx.theme.node.muted }}><Pencil size={24} /><span>连接图片后绘制蒙版</span></div>}
        {draft ? <PaintMaskEditor initial={draft} image={source?.content || ""} theme={ctx.theme} hostRef={hostRef} saving={saving} error={error || (!paintMaskMatches(draft, source) ? "原图已变化，请取消后重新开始。" : "")} onCancel={cancel} onSave={next => void save(next)} /> : null}
    </div>;
}

function PaintMaskPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const inputs = ctx.node.metadata?.productionInputs || [];
    const source = getPaintMaskSource(ctx.node);
    const valid = paintMaskMatches(ctx.node.metadata?.paintMask, source);
    return <div className="mx-auto max-w-[440px] space-y-3 rounded-2xl border p-3" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text, borderColor: ctx.theme.node.stroke }}>
        <header className="flex items-center justify-between"><strong className="text-canvas-title font-semibold">手绘蒙版</strong><button className={processButton} aria-label="关闭蒙版设置" onClick={onClose}><X size={14} /></button></header>
        <div className="flex items-center gap-2">
            <button className={processButton} disabled={!source?.content} onClick={() => ctx.emit(editEvent, eventFor(ctx))}><Pencil size={18} />绘制蒙版</button>
            <button className={processButton} disabled={!valid || !ctx.node.metadata?.content} onClick={() => ctx.emit(previewEvent, eventFor(ctx))}><Eye size={16} />切换黑白预览</button>
        </div>
        <p className="text-canvas-caption" style={{ color: ctx.theme.node.muted }}>{inputs.length > 1 ? "只接受一张原图，请先移除多余输入连线。" : ctx.node.metadata?.paintMask && !valid ? "原图已变化，旧蒙版暂停输出，请重新绘制。" : "只接受一张原图。白色为选区，黑色为未选区域。输出独立 PNG，可连接羽化、扩缩或合成 Alpha。双击图片也可绘制。"}</p>
        {ctx.node.metadata?.errorDetails ? <p role="alert" className="text-canvas-ui">{ctx.node.metadata.errorDetails}</p> : null}
    </div>;
}

export function registerPaintMaskNode() {
    registerNodeDefinitions([{
        type: MASK_PAINT, title: "手绘蒙版", description: "在原图上画选区，保留可编辑笔画，输出独立黑白蒙版", category: "image", icon: <Pencil size={16} />,
        defaultSize: { width: 480, height: 320 }, autoOpenPanel: true, keepAspectRatio: () => true,
        Content: PaintMaskContent, Panel: PaintMaskPanel,
        toolbar: ctx => [{ id: "paint-mask-draw", title: "绘制蒙版", label: "绘制", icon: <Pencil size={16} />, onClick: () => ctx.emit(editEvent, eventFor(ctx)) }],
        onDoubleClick: ctx => { ctx.emit(editEvent, eventFor(ctx)); return true; },
        resource: node => node.metadata?.status === "success" && node.metadata.content ? { kind: "image", url: node.metadata.content } : null,
    }]);
}
