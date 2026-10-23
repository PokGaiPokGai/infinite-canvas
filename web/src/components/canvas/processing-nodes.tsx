import { useRef, type ReactNode } from "react";
import { Blend, Layers, Workflow, Play, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";
import { MASK_EXTRACT, MASK_INVERT, MASK_GROW, MASK_FEATHER, ALPHA_APPLY, MASK_TYPES } from "@/lib/canvas/image-mask";
import { BATCH_NODE, WORKFLOW_NODE, EMPTY_WORKFLOW } from "@/lib/canvas/workflow-graph";
import { runMaskChain, cancelProcessing, isProcessing } from "@/lib/canvas/production-runner";
import { BatchPanel } from "./batch-process-panel";
import { WorkflowPanel } from "./workflow-process-panel";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

export const processButton = "inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
export const processField = "w-full min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none";
function processingResource(node: CanvasNodeContext["node"]) {
    if (node.metadata?.status === "loading" || node.metadata?.status === "error") return null;
    return node.metadata?.outputKind === "text" ? { kind: "text" as const, text: node.metadata.content } : { kind: "image" as const, url: node.metadata?.content };
}
export function ProcessingPanel({ ctx, title, onClose, children }: { ctx: CanvasNodeContext; title: string; onClose: () => void; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const rect = useCanvasPopoverAnchor(ref, true);
    const area = ref.current?.closest("section")?.getBoundingClientRect();
    const left = Math.max(12, (area?.left || 0) + 12);
    const right = Math.min(window.innerWidth, area?.right ?? window.innerWidth) - 12;
    const width = Math.min(640, right - left);
    const naturalLeft = (rect?.left || 0) + ((rect?.width || 600) - width) / 2;
    const shift = rect ? Math.max(left, Math.min(naturalLeft, right - width)) - naturalLeft : 0;
    const bottom = (document.querySelector("[data-canvas-bottom-toolbar]")?.getBoundingClientRect().top ?? window.innerHeight - 64) - 12;
    return <div ref={ref} className="w-full"><div data-processing-panel className="mx-auto space-y-3 overflow-y-auto rounded-2xl border p-4" style={{ width, transform: `translateX(${shift}px)`, maxHeight: Math.max(160, bottom - (rect?.top ?? 12)), background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }} data-canvas-no-zoom>
        <header className="flex items-center gap-2"><strong className="flex-1 text-sm">{title}</strong><button className={processButton} aria-label="关闭处理面板" onClick={onClose}><X size={16} /></button></header>
        {children}
        {ctx.node.metadata?.errorDetails ? <p role="alert" className="break-words text-xs leading-5">{ctx.node.metadata.errorDetails}</p> : null}
    </div></div>;
}

function ProcessingContent({ ctx }: { ctx: CanvasNodeContext }) {
    const data = ctx.node.metadata;
    if (data?.content && (MASK_TYPES.includes(ctx.node.type) || data.outputKind === "image")) return <img src={data.content} draggable={false} className="pointer-events-none h-full w-full rounded-[inherit] object-cover" alt={ctx.node.title} />;
    return <div className="flex h-full w-full flex-col justify-center gap-3 overflow-hidden rounded-[inherit] p-5" style={{ color: ctx.theme.node.text }}>
        {ctx.node.type === WORKFLOW_NODE ? <Workflow size={24} /> : ctx.node.type === BATCH_NODE ? <Layers size={24} /> : <Blend size={24} />}
        <strong className="text-sm">{ctx.node.metadata?.workflow?.name || ctx.node.title}</strong>
        {data?.outputKind === "text" && data.content ? <p className="line-clamp-5 whitespace-pre-wrap text-xs">{data.content}</p> : <span className="text-xs" style={{ color: ctx.theme.node.muted }}>{ctx.node.type === WORKFLOW_NODE ? `${data?.workflow?.nodes.length || 0} 个步骤 · 点击配置流程` : ctx.node.type === BATCH_NODE ? `${data?.batchRows?.filter(row => row.state === "success").length || 0} 项完成 · 点击准备批次` : "连接图片，点击设置并更新蒙版链"}</span>}
    </div>;
}

function MaskPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const settings = ctx.node.metadata?.maskSettings || {};
    const inputs = ctx.node.metadata?.productionInputs || [];
    const busy = isProcessing(ctx);
    const patch = (value: typeof settings) => ctx.updateMetadata({ maskSettings: { ...settings, ...value }, errorDetails: undefined });
    const style = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    return <ProcessingPanel ctx={ctx} title={ctx.node.title} onClose={onClose}>
        {ctx.node.type === MASK_EXTRACT ? <label className="block space-y-1 text-xs">提取通道<select aria-label="蒙版提取通道" className={processField} style={style} disabled={busy} value={settings.channel || "alpha"} onChange={event => patch({ channel: event.target.value as "alpha" | "luminance" })}><option value="alpha">Alpha 透明度</option><option value="luminance">灰度亮度 × Alpha</option></select></label> : null}
        {ctx.node.type === MASK_GROW ? <label className="block space-y-1 text-xs">扩缩像素（正数扩张，负数收缩）<input aria-label="蒙版扩缩像素" type="number" className={processField} style={style} disabled={busy} value={settings.amount ?? 4} onChange={event => patch({ amount: Number(event.target.value) })} /></label> : null}
        {ctx.node.type === MASK_FEATHER ? <label className="block space-y-1 text-xs">羽化半径（像素）<input aria-label="蒙版羽化半径" type="number" min="0" className={processField} style={style} disabled={busy} value={settings.radius ?? 4} onChange={event => patch({ radius: Number(event.target.value) })} /></label> : null}
        {ctx.node.type === ALPHA_APPLY ? <div className="grid grid-cols-2 gap-3">{([['imageId', '原图'], ['maskId', '蒙版']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-xs">{label}<select aria-label={`Alpha ${label}`} className={processField} style={style} disabled={busy} value={inputs.some(input => input.id === settings[key]) ? settings[key] : ""} onChange={event => patch({ [key]: event.target.value })}><option value="" disabled hidden>选择{label}</option>{inputs.map(input => <option key={input.id} value={input.id}>{input.title}</option>)}</select></label>)}</div> : null}
        <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>白色保留，黑色去除。蒙版输出为灰度 PNG；合成 Alpha 保留原图 RGB，并乘上原有透明度。更新会依次处理上游蒙版步骤，不会自动调用生成模型。</p>
        <div className="flex gap-2"><button className={processButton} disabled={busy} onClick={() => void runMaskChain(ctx)}><Play size={14} />更新蒙版链</button>{busy ? <button className={processButton} onClick={() => cancelProcessing(ctx)}>取消处理</button> : null}</div>
    </ProcessingPanel>;
}

export function registerProcessingNodes() {
    registerNodeDefinitions([
        ...([[MASK_EXTRACT, "提取蒙版"], [MASK_INVERT, "反转蒙版"], [MASK_GROW, "扩张 / 收缩蒙版"], [MASK_FEATHER, "羽化蒙版"], [ALPHA_APPLY, "合成 Alpha"]] as const).map(([type, title]) => ({ type, title, icon: <Blend size={16} />, defaultSize: { width: 320, height: 260 }, autoOpenPanel: true, Content: ProcessingContent, Panel: MaskPanel, resource: processingResource })),
        { type: BATCH_NODE, title: "批处理 / 参数矩阵", icon: <Layers size={16} />, defaultSize: { width: 340, height: 260 }, defaultMetadata: { batchSettings: { mode: "image", prompt: "{input}", inputText: "", model: "", size: "", axes: [] } }, autoOpenPanel: true, Content: ProcessingContent, Panel: BatchPanel, resource: processingResource },
        { type: WORKFLOW_NODE, title: "复用流程", icon: <Workflow size={16} />, defaultSize: { width: 340, height: 260 }, defaultMetadata: { workflow: EMPTY_WORKFLOW }, autoOpenPanel: true, Content: ProcessingContent, Panel: WorkflowPanel, resource: processingResource },
    ], "processing");
}
