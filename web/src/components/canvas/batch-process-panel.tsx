import { Play, Plus, RotateCcw, X, Download } from "lucide-react";
import { nanoid } from "nanoid";
import { ProcessingPanel, processButton, processField } from "./processing-nodes";
import { runBatch, cancelProcessing, isProcessing, resultMetadata } from "@/lib/canvas/production-runner";
import { REFERENCE_PACK } from "@/lib/canvas/canvas-production";
import { nodeResult } from "@/lib/canvas/workflow-graph";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { BatchSettings, MatrixField, ProcessResult } from "@/types/canvas-workflow";
import { CanvasNodeType } from "@/types/canvas";

const fieldNames: Record<MatrixField, string> = { prompt: "提示词", model: "模型标识", size: "尺寸", seed: "种子（ComfyUI）", steps: "步数（ComfyUI）", cfg: "CFG（ComfyUI）", denoise: "改绘强度（ComfyUI）" };
const stateNames = { pending: "待执行", running: "执行中", success: "已完成", error: "失败", cancelled: "已取消" };

export function placeProcessResults(ctx: CanvasNodeContext, results: ProcessResult[]) {
    ctx.applyOps(results.map((result, index) => ({ type: "add_node" as const, id: nanoid(), nodeType: result.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text, title: result.title, position: { x: ctx.node.position.x + ctx.node.width + 60 + index % 3 * 350, y: ctx.node.position.y + Math.floor(index / 3) * 310 }, width: 320, height: result.kind === "image" && result.naturalWidth && result.naturalHeight ? 320 * result.naturalHeight / result.naturalWidth : 250, metadata: { ...result, status: "success" as const } })));
}

export function BatchPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const settings = ctx.node.metadata?.batchSettings!;
    const rows = ctx.node.metadata?.batchRows || [];
    const busy = isProcessing(ctx);
    const models = ctx.ai.listModels(settings.mode);
    const patch = (value: Partial<BatchSettings>) => ctx.updateMetadata({ batchSettings: { ...settings, ...value }, errorDetails: undefined });
    const style = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    const upstream = ctx.getUpstream().filter(node => node.type !== REFERENCE_PACK);
    const inputs = settings.inputText.split(/\r?\n/).filter(line => line.trim()).length + upstream.reduce((sum, node) => { const result = nodeResult(node); return sum + (result?.kind === "text" ? result.content.split(/\r?\n/).filter(line => line.trim()).length : 1); }, 0);
    const count = Math.max(1, inputs) * settings.axes.reduce((size, axis) => size * axis.values.filter(value => value.trim()).length, 1);
    const results = rows.flatMap(row => row.result ? [{ ...row.config, ...row.result, id: row.id, title: `${row.input.kind === 'text' ? row.input.content || row.input.title : row.input.title} · ${Object.values(row.params).join(' / ') || '默认参数'}` }] : []);
    return <ProcessingPanel ctx={ctx} title="批处理 / 参数矩阵" onClose={onClose}>
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
            <div className="grid grid-cols-2 gap-2"><select aria-label="批处理模式" className={processField} style={style} value={settings.mode} onChange={event => patch({ mode: event.target.value as BatchSettings['mode'], model: "" })}><option value="image">生成图片</option><option value="text">生成文本</option></select><select aria-label="批处理模型" className={processField} style={style} value={models.some(model => model.value === settings.model) ? settings.model : ""} onChange={event => patch({ model: event.target.value })}><option value="" disabled hidden>使用当前默认模型</option>{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></div>
            <label className="block space-y-1 text-xs">文本输入列表 · 每行一项<textarea aria-label="批处理输入列表" className={`${processField} min-h-20`} style={style} value={settings.inputText} onChange={event => patch({ inputText: event.target.value })} placeholder="沙漠石柱\n破损石墙\n营地路标" /></label>
            <label className="block space-y-1 text-xs">提示词模板<textarea aria-label="批处理提示词" className={`${processField} min-h-20`} style={style} value={settings.prompt} onChange={event => patch({ prompt: event.target.value })} /></label>
            <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>{"{input} 插入当前文本或图片名，{index} 插入输入序号。连接图片会逐张执行；参考包作为每项共享的规则和参考。"}</p>
            {settings.mode === "image" ? <input aria-label="批处理默认尺寸" className={processField} style={style} value={settings.size} placeholder="默认尺寸，例如 1024x1024；留空使用渠道设置" onChange={event => patch({ size: event.target.value })} /> : null}
            <div className="flex items-center justify-between text-xs"><strong>参数矩阵 · 各维度组合</strong><button type="button" className={processButton} onClick={() => patch({ axes: [...settings.axes, { field: "prompt", values: [""] }] })}><Plus size={14} />添加维度</button></div>
            {settings.axes.map((axis, index) => <div key={index} className="grid grid-cols-[140px_1fr_auto] items-start gap-2"><select aria-label={`矩阵维度 ${index + 1}`} className={processField} style={style} value={axis.field} onChange={event => patch({ axes: settings.axes.map((value, i) => i === index ? { ...value, field: event.target.value as MatrixField } : value) })}>{Object.entries(fieldNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><textarea aria-label={`矩阵取值 ${index + 1}`} className={`${processField} min-h-16`} style={style} value={axis.values.join('\n')} placeholder="每行一个值" onChange={event => patch({ axes: settings.axes.map((value, i) => i === index ? { ...value, values: event.target.value.split('\n') } : value) })} /><button type="button" className={processButton} aria-label={`删除矩阵维度 ${index + 1}`} onClick={() => patch({ axes: settings.axes.filter((_, i) => i !== index) })}><X size={14} /></button></div>)}
        </fieldset>
        <p className="text-xs" role="status">下一批共 {count} 项，逐项执行。失败后继续后续项，不自动重试。</p>
        <div className="flex flex-wrap gap-2"><button className={processButton} disabled={busy || !count} onClick={() => void runBatch(ctx, "all")}><Play size={14} />开始新批次</button><button className={processButton} disabled={busy || !rows.some(row => row.state === "error")} onClick={() => void runBatch(ctx, "failed")}><RotateCcw size={14} />仅重试失败项</button><button className={processButton} disabled={busy || !rows.some(row => ["pending", "cancelled", "running"].includes(row.state))} onClick={() => void runBatch(ctx, "unfinished")}>继续未完成项</button>{busy ? <button className={processButton} onClick={() => cancelProcessing(ctx)}>取消批次</button> : null}</div>
        {rows.length ? <>
            <div className="flex items-center justify-between"><span className="text-xs">当前批次 · {rows.filter(row => row.state === 'success').length} / {rows.length} 完成</span><button className={processButton} disabled={!results.length} onClick={() => { placeProcessResults(ctx, results); onClose(); }}><Download size={14} />全部结果放到画布</button></div>
            <div className="max-h-80 space-y-2 overflow-auto" data-batch-results>{rows.map((row, index) => <div key={row.id} className="grid grid-cols-[48px_1fr_auto] gap-2 border-t py-2 text-xs" style={{ borderColor: ctx.theme.node.stroke }}>
                {row.result?.kind === "image" ? <img src={row.result.content} className="h-12 w-12 rounded object-cover" alt={row.input.title} /> : <span className="py-2 text-center tabular-nums">{index + 1}</span>}
                <div className="min-w-0 space-y-1"><strong className="block truncate">{row.input.kind === 'text' ? row.input.content || row.input.title : row.input.title}</strong><span className="block break-words" style={{ color: ctx.theme.node.muted }}>{Object.entries(row.params).map(([key, value]) => `${fieldNames[key as MatrixField]}：${value}`).join(' · ') || '默认参数'}</span><span>{row.state === 'running' && !busy ? '执行中断，可继续' : stateNames[row.state]}</span><details><summary className="cursor-pointer" style={{ color: ctx.theme.node.muted }}>本项输入与参数</summary><p className="whitespace-pre-wrap break-words">{row.config.prompt}</p><p className="break-all">模型：{row.config.model} · 尺寸：{row.config.size || '渠道默认'}</p></details>{row.error ? <p role="alert" className="break-words">{row.error}</p> : null}{row.result?.kind === 'text' ? <p className="line-clamp-3 whitespace-pre-wrap">{row.result.content}</p> : null}</div>
                {row.result ? <button className={processButton} aria-pressed={ctx.node.metadata?.selectedProcessResultId === row.id} onClick={() => ctx.updateMetadata({ ...resultMetadata({ ...row.result!, id: row.id }), status: "success" })}>设为输出</button> : null}
            </div>)}</div>
            <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>重试和继续使用原批次保存的输入、模型与参数。修改上方设置只影响“开始新批次”；新批次会替换当前结果列表，需保留时先放到画布。</p>
        </> : null}
    </ProcessingPanel>;
}
