import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { BatchSettings, BatchRow, ProcessResult } from "@/types/canvas-workflow";
import { isConnectionOperational } from "./canvas-connection-state";
import { MASK_TYPES, processMask, maskInputKey } from "./image-mask";
import { nodeResult, validateWorkflow } from "./workflow-graph";
import { REFERENCE_PACK, referencePackText } from "./canvas-production";

const runs = new Map<string, AbortController>();
const runKey = (ctx: CanvasNodeContext) => `${ctx.projectId}:${ctx.node.id}`;
const maskOutput = (node: CanvasNodeData): CanvasNodeMetadata => ({ ...resultMetadata(nodeResult(node) || undefined), processOutputKey: node.metadata?.processOutputKey, status: "success", errorDetails: undefined });
export const isProcessing = (ctx: CanvasNodeContext) => runs.has(runKey(ctx));
export const cancelProcessing = (ctx: CanvasNodeContext) => runs.get(runKey(ctx))?.abort();
export function cancelProjectProcessing(projectId: string) { for (const [key, controller] of runs) if (key.startsWith(projectId + ":")) controller.abort(); }
export const resultMetadata = (result?: ProcessResult): CanvasNodeMetadata => ({ content: result?.content, storageKey: result?.storageKey, naturalWidth: result?.naturalWidth, naturalHeight: result?.naturalHeight, mimeType: result?.mimeType, bytes: result?.bytes, outputKind: result?.kind, selectedProcessResultId: result?.id });

export async function managedProcessing(ctx: CanvasNodeContext, work: (signal: AbortSignal) => Promise<CanvasNodeMetadata>) {
    if (runs.has(runKey(ctx))) return;
    const controller = new AbortController(); runs.set(runKey(ctx), controller);
    ctx.updateMetadata({ status: "loading", errorDetails: undefined });
    try {
        const result = await work(controller.signal);
        controller.signal.throwIfAborted();
        if (ctx.getNode(ctx.node.id)) ctx.updateMetadata({ ...result, status: "success" });
    } catch (error) {
        if (ctx.getNode(ctx.node.id)) ctx.updateMetadata({ status: "error", errorDetails: controller.signal.aborted ? "已取消。已完成的批次结果保留，可继续未完成项。" : error instanceof Error ? error.message : "处理失败。" });
    } finally { runs.delete(runKey(ctx)); }
}

// A local copy of the dependency graph makes each run independent of edits during execution.
async function evaluate(nodes: CanvasNodeData[], edges: CanvasConnection[], outputs: string[], ctx: CanvasNodeContext, signal: AbortSignal, generate: boolean) {
    const byId = new Map(structuredClone(nodes).map(node => [node.id, node]));
    const active = new Set<string>(); const done = new Set<string>();
    const visit = async (id: string): Promise<CanvasNodeData> => {
        signal.throwIfAborted();
        if (!ctx.getNode(ctx.node.id)) throw new DOMException("处理节点已移除", "AbortError");
        const node = byId.get(id);
        if (!node) throw new Error("步骤引用的节点不存在。");
        if (done.has(id)) return node;
        if (active.has(id)) throw new Error("步骤之间存在循环连线。");
        active.add(id);
        const executable = MASK_TYPES.includes(node.type) || generate && node.type === CanvasNodeType.Config;
        if (executable) {
            const incoming = edges.filter(edge => edge.toNodeId === id && isConnectionOperational(edge, byId.get(edge.fromNodeId), node));
            const sources: CanvasNodeData[] = [];
            for (const edge of incoming) sources.push(await visit(edge.fromNodeId));
            let patch: CanvasNodeMetadata;
            if (MASK_TYPES.includes(node.type)) {
                const inputs = sources.map(source => nodeResult(source));
                if (inputs.some(input => !input)) throw new Error(`「${node.title}」的上游尚无有效结果。`);
                const key = maskInputKey(node.type, node.metadata?.maskSettings, inputs as ProcessResult[]);
                // Stable intermediates keep sibling branches valid when their pixels did not change.
                patch = key === node.metadata?.processOutputKey && nodeResult(node) ? {} : { ...await processMask(node.type, node.metadata?.maskSettings || {}, inputs as ProcessResult[], signal), processOutputKey: key };
            } else {
                if (sources.some(source => source.type !== REFERENCE_PACK && !nodeResult(source))) throw new Error(`「${node.title}」有未就绪的输入。`);
                patch = await ctx.ai.generateConfigured(node, [...byId.values()], edges, signal);
            }
            node.metadata = { ...node.metadata, ...patch };
        }
        active.delete(id); done.add(id); return node;
    };
    for (const output of outputs) await visit(output);
    return { nodes: [...byId.values()], executed: [...done].filter(id => MASK_TYPES.includes(byId.get(id)!.type) || generate && byId.get(id)!.type === CanvasNodeType.Config) };
}

export function runMaskChain(ctx: CanvasNodeContext) {
    const nodes = structuredClone(ctx.getNodes()); const connections = structuredClone(ctx.getConnections());
    // managedProcessing marks the display node busy; the captured graph retains its input snapshot.
    return managedProcessing(ctx, async signal => {
        const result = await evaluate(nodes, connections, [ctx.node.id], ctx, signal, false);
        signal.throwIfAborted();
        ctx.applyOps(result.executed.filter(id => id !== ctx.node.id && ctx.getNode(id)).map(id => ({ type: "update_node" as const, id, metadata: maskOutput(result.nodes.find(node => node.id === id)!) })));
        return maskOutput(result.nodes.find(node => node.id === ctx.node.id)!);
    });
}

export function prepareBatch(settings: BatchSettings, upstream: CanvasNodeData[], defaultModel: string, connections: CanvasConnection[] = []): BatchRow[] {
    const inputs: ProcessResult[] = settings.inputText.split(/\r?\n/).filter(line => line.trim()).map((line, index) => ({ id: nanoid(), title: `文本 ${index + 1}`, kind: "text", content: line }));
    const shared: ProcessResult[] = [];
    for (const source of upstream) {
        const pack = source.metadata?.referencePack;
        if (source.type === REFERENCE_PACK && pack) {
            shared.push({ id: `${source.id}:rules`, title: pack.name, kind: "text", content: referencePackText(pack) }, ...pack.images.map(image => ({ ...image, id: `${source.id}:${image.id}`, kind: "image" as const, content: image.content || "", role: pack.kind === "character" ? "character" as const : "style" as const })));
            continue;
        }
        const result = nodeResult(source);
        if (!result) throw new Error(`输入「${source.title}」未就绪。`);
        result.role = connections.find(edge => edge.fromNodeId === source.id)?.role;
        if (result.kind === "text") inputs.push(...result.content.split(/\r?\n/).filter(line => line.trim()).map((line, index) => ({ ...result, id: `${result.id}:${index}`, title: `${result.title} ${index + 1}`, content: line })));
        else inputs.push(result);
    }
    if (!inputs.length) inputs.push({ id: nanoid(), title: "无外部输入", kind: "text", content: "" });
    let combinations: BatchRow["params"][] = [{}];
    const fields = new Set<string>();
    for (const axis of settings.axes) {
        if (fields.has(axis.field)) throw new Error("每个参数只能设置一个矩阵维度。");
        fields.add(axis.field);
        const values = axis.values.map(value => value.trim()).filter(Boolean);
        if (!values.length) throw new Error("每个矩阵维度至少填写一个值。");
        for (const value of values) {
            const number = Number(value);
            if (["seed", "steps", "cfg", "denoise"].includes(axis.field) && (!Number.isFinite(number) || (axis.field === "seed" && (!Number.isSafeInteger(number) || number < -1)) || (axis.field === "steps" && (!Number.isSafeInteger(number) || number <= 0)) || (axis.field === "cfg" && number < 0) || (axis.field === "denoise" && (number < 0 || number > 1)))) throw new Error(`参数 ${axis.field} 包含无效数值。`);
            if (settings.mode === "text" && !["prompt", "model"].includes(axis.field)) throw new Error("文本矩阵使用提示词与模型维度。");
        }
        combinations = combinations.flatMap(combo => values.map(value => ({ ...combo, [axis.field]: value })));
    }
    return inputs.flatMap((input, index) => combinations.map(params => {
        const prompt = (params.prompt ?? settings.prompt).replaceAll("{input}", input.kind === "text" ? input.content : input.title).replaceAll("{index}", String(index + 1));
        if (!prompt.trim()) throw new Error("请填写提示词，文本列表可通过 {input} 插入。");
        const comfy = Object.fromEntries(["seed", "steps", "cfg", "denoise"].filter(field => params[field as keyof typeof params] !== undefined).map(field => [field, Number(params[field as keyof typeof params])]));
        return { id: nanoid(), input: structuredClone(input), params, config: { generationMode: settings.mode, prompt, model: params.model || settings.model || defaultModel, size: params.size || settings.size, count: 1, ...(Object.keys(comfy).length ? { comfy } : {}) }, references: structuredClone([...(input.kind === "image" ? [input] : []), ...shared]), state: "pending" as const };
    }));
}

export function runBatch(ctx: CanvasNodeContext, kind: "all" | "failed" | "unfinished") {
    return managedProcessing(ctx, async signal => {
        const settings = ctx.node.metadata?.batchSettings!;
        const rows = kind === "all" ? prepareBatch(settings, ctx.getUpstream(), ctx.ai.defaultModel(settings.mode), ctx.getConnections().filter(edge => edge.toNodeId === ctx.node.id)) : structuredClone(ctx.node.metadata?.batchRows || []);
        if (!rows.length) throw new Error("请先准备一个批次。");
        const selected = rows.filter(row => kind === "all" || (kind === "failed" ? row.state === "error" : ["pending", "cancelled", "running"].includes(row.state)));
        if (!selected.length) throw new Error(kind === "failed" ? "没有失败项。" : "没有未完成项。");
        const publish = () => { if (ctx.getNode(ctx.node.id)) ctx.updateMetadata({ batchRows: structuredClone(rows), processResults: rows.flatMap(row => row.result ? [{ ...row.result, id: row.id }] : []) }); };
        publish();
        for (const row of selected) {
            if (signal.aborted || !ctx.getNode(ctx.node.id)) break;
            row.state = "running"; row.error = undefined; publish();
            try {
                const target: CanvasNodeData = { id: row.id, title: row.input.title, type: CanvasNodeType.Config, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: row.config };
                const refs: CanvasNodeData[] = row.references.map(result => ({ id: nanoid(), title: result.title, type: result.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { ...result, status: "success" } }));
                const edges = refs.map((node, index) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: target.id, role: row.references[index].role }));
                target.metadata = { ...row.config, ...await ctx.ai.generateConfigured(target, [...refs, target], edges, signal) };
                signal.throwIfAborted();
                row.result = nodeResult(target) || undefined;
                if (!row.result) throw new Error("没有可用结果。");
                row.state = "success";
            } catch (error) { row.state = signal.aborted ? "cancelled" : "error"; row.error = signal.aborted ? "已取消" : error instanceof Error ? error.message : "执行失败"; }
            publish();
        }
        const results = rows.flatMap(row => row.result ? [{ ...row.result, id: row.id }] : []);
        return { batchRows: rows, processResults: results, ...resultMetadata(results.find(result => result.id === ctx.getNode(ctx.node.id)?.metadata?.selectedProcessResultId) || results[0]), errorDetails: rows.some(row => row.state === "error") ? "部分项目失败，可仅重试失败项。" : undefined };
    });
}

export function runWorkflow(ctx: CanvasNodeContext) {
    const workflow = structuredClone(ctx.node.metadata?.workflow!);
    const originalDefinition = JSON.stringify(workflow);
    const upstream = structuredClone(ctx.getUpstream());
    return managedProcessing(ctx, async signal => {
        if (workflow.expandedGroupId) throw new Error("请先收起编辑中的步骤，再执行流程。");
        validateWorkflow(workflow);
        for (const input of workflow.inputs) {
            const sourceId = workflow.bindings[input.id];
            if (!sourceId) continue; // An unbound input uses the stored default snapshot.
            const source = upstream.find(node => node.id === sourceId);
            const result = source && nodeResult(source);
            if (!result || result.kind !== input.kind) throw new Error(`输入「${input.name}」的连线或类型无效。`);
            const target = workflow.nodes.find(node => node.id === input.nodeId)!;
            target.metadata = { ...result, status: "success" };
        }
        for (const parameter of workflow.parameters) {
            const node = workflow.nodes.find(node => node.id === parameter.nodeId);
            if (!node) throw new Error(`参数「${parameter.name}」绑定失效。`);
            const value = workflow.values[parameter.id] ?? parameter.value;
            node.metadata = ["amount", "radius"].includes(parameter.field) ? { ...node.metadata, maskSettings: { ...node.metadata?.maskSettings, [parameter.field]: Number(value) } } : { ...node.metadata, [parameter.field]: value, ...(parameter.field === "prompt" ? { composerContent: undefined } : {}) };
        }
        const graph = await evaluate(workflow.nodes, workflow.connections, workflow.outputs.map(output => output.nodeId), ctx, signal, true);
        if (JSON.stringify(ctx.getNode(ctx.node.id)?.metadata?.workflow) !== originalDefinition) throw new Error("执行期间流程设置发生变化，请使用当前设置重新运行。");
        const results = workflow.outputs.map(output => {
            const result = nodeResult(graph.nodes.find(node => node.id === output.nodeId)!);
            if (!result) throw new Error(`输出「${output.name}」尚未就绪。`);
            return { ...result, id: output.id, title: output.name };
        });
        return { workflow: { ...workflow, nodes: graph.nodes }, processResults: results, ...resultMetadata(results.find(result => result.id === ctx.node.metadata?.selectedProcessResultId) || results[0]) };
    });
}
