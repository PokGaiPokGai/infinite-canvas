import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Blend, Layers, Workflow, RotateCcw } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { ProcessingPanel, processButton, processField } from "./processing-panel";
import { MASK_EXTRACT, MASK_INVERT, MASK_GROW, MASK_FEATHER, ALPHA_APPLY, MASK_TYPES } from "@/lib/canvas/image-mask";
import { BATCH_NODE, WORKFLOW_NODE, EMPTY_WORKFLOW } from "@/lib/canvas/workflow-graph";
import { BatchPanel } from "./batch-process-panel";
import { WorkflowPanel } from "./workflow-process-panel";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

function processingResource(node: CanvasNodeContext["node"]) {
    if (node.metadata?.status === "loading" || node.metadata?.status === "error") return null;
    return node.metadata?.outputKind === "text" ? { kind: "text" as const, text: node.metadata.content } : { kind: "image" as const, url: node.metadata?.content };
}

function ProcessingContent({ ctx }: { ctx: CanvasNodeContext }) {
    const data = ctx.node.metadata;
    if (data?.content && (MASK_TYPES.includes(ctx.node.type) || data.outputKind === "image")) return <img src={data.content} draggable={false} className="pointer-events-none h-full w-full rounded-[inherit] object-cover" alt={ctx.node.title} />;
    return <div className="flex h-full w-full flex-col justify-center gap-3 overflow-hidden rounded-[inherit] p-5" style={{ color: ctx.theme.node.text }}>
        {ctx.node.type === WORKFLOW_NODE ? <Workflow size={24} /> : ctx.node.type === BATCH_NODE ? <Layers size={24} /> : <Blend size={24} />}
        <strong className="text-sm">{ctx.node.metadata?.workflow?.name || ctx.node.title}</strong>
        {data?.outputKind === "text" && data.content ? <p className="line-clamp-5 whitespace-pre-wrap text-xs">{data.content}</p> : <span className="text-xs" style={{ color: ctx.theme.node.muted }}>{ctx.node.type === WORKFLOW_NODE ? `${data?.workflow?.nodes.length || 0} 个步骤 · 点击配置流程` : ctx.node.type === BATCH_NODE ? `${data?.batchRows?.filter(row => row.state === "success").length || 0} 项完成 · 点击准备批次` : data?.status === "loading" ? "正在更新…" : data?.status === "error" ? "更新失败，点击查看" : "等待图片输入"}</span>}
    </div>;
}

function MaskNumberField({ value, label, min, style, onCommit }: { value: number; label: string; min?: number; style: CSSProperties; onCommit: (value: number) => void }) {
    const draft = useRef<string | null>(null);
    const callback = useRef(onCommit);
    useLayoutEffect(() => { callback.current = onCommit; });
    const commit = () => {
        const text = draft.current;
        draft.current = null;
        if (text?.trim() && Number(text) !== value) callback.current(Number(text));
    };
    // Outside pointer-down can close the panel before the input receives blur.
    useLayoutEffect(() => () => commit(), []);
    return <input aria-label={label} type="number" min={min} className={processField} style={style} defaultValue={value} onChange={event => { draft.current = event.currentTarget.value; }} onBlur={event => {
        commit();
        if (!event.currentTarget.value.trim()) event.currentTarget.value = String(value);
    }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function MaskPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const settings = ctx.node.metadata?.maskSettings || {};
    const inputs = ctx.node.metadata?.productionInputs || [];
    const patch = (value: typeof settings) => ctx.updateMetadata({ maskSettings: { ...settings, ...value }, errorDetails: undefined });
    const style = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    const numberField = (field: "amount" | "radius", label: string) => <MaskNumberField key={`${ctx.node.id}:${field}:${settings[field] ?? 4}`} value={settings[field] ?? 4} label={label} min={field === "radius" ? 0 : undefined} style={style} onCommit={value => patch({ [field]: value })} />;
    return <ProcessingPanel ctx={ctx} title={ctx.node.title} onClose={onClose}>
        {ctx.node.type === MASK_EXTRACT ? <label className="block space-y-1 text-xs">提取通道<select aria-label="蒙版提取通道" className={processField} style={style} value={settings.channel || "alpha"} onChange={event => patch({ channel: event.target.value as "alpha" | "luminance" })}><option value="alpha">Alpha 透明度</option><option value="luminance">灰度亮度 × Alpha</option></select></label> : null}
        {ctx.node.type === MASK_GROW ? <label className="block space-y-1 text-xs">扩缩像素（正数扩张，负数收缩）{numberField("amount", "蒙版扩缩像素")}</label> : null}
        {ctx.node.type === MASK_FEATHER ? <label className="block space-y-1 text-xs">羽化半径（像素）{numberField("radius", "蒙版羽化半径")}</label> : null}
        {ctx.node.type === ALPHA_APPLY ? <div className="grid grid-cols-2 gap-3">{([['imageId', '原图'], ['maskId', '蒙版']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-xs">{label}<select aria-label={`Alpha ${label}`} className={processField} style={style} value={inputs.some(input => input.id === settings[key]) ? settings[key] : ""} onChange={event => patch({ [key]: event.target.value })}><option value="" disabled hidden>选择{label}</option>{inputs.map(input => <option key={input.id} value={input.id}>{input.title}</option>)}</select></label>)}</div> : null}
        <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>白色保留，黑色去除。输入或参数变化后自动更新；数值输入按回车或离开输入框后生效。合成 Alpha 保留原图 RGB，并乘上原有透明度。</p>
        {ctx.node.metadata?.status === "error" ? <button className={processButton} onClick={() => ctx.updateMetadata({ processErrorKey: undefined, processRunKey: undefined, status: "idle", errorDetails: undefined })}><RotateCcw size={14} />重试</button> : null}
    </ProcessingPanel>;
}

export function registerProcessingNodes() {
    registerNodeDefinitions([
        ...([[MASK_EXTRACT, "提取蒙版"], [MASK_INVERT, "反转蒙版"], [MASK_GROW, "扩张 / 收缩蒙版"], [MASK_FEATHER, "羽化蒙版"], [ALPHA_APPLY, "合成 Alpha"]] as const).map(([type, title]) => ({ type, title, category: "image" as const, icon: <Blend size={16} />, defaultSize: { width: 320, height: 260 }, autoOpenPanel: true, Content: ProcessingContent, Panel: MaskPanel, resource: processingResource })),
        { type: BATCH_NODE, category: "generation", title: "批处理 / 参数矩阵", icon: <Layers size={16} />, defaultSize: { width: 340, height: 260 }, defaultMetadata: { batchSettings: { mode: "image", prompt: "{input}", inputText: "", model: "", size: "", axes: [] } }, autoOpenPanel: true, Content: ProcessingContent, Panel: BatchPanel, resource: processingResource },
        { type: WORKFLOW_NODE, category: "generation", title: "复用流程", icon: <Workflow size={16} />, defaultSize: { width: 340, height: 260 }, defaultMetadata: { workflow: EMPTY_WORKFLOW }, autoOpenPanel: true, Content: ProcessingContent, Panel: WorkflowPanel, resource: processingResource },
    ], "processing");
}
