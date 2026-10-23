import { useState } from "react";
import { nanoid } from "nanoid";
import { Play, Save, Plus, X, Expand, Minimize } from "lucide-react";
import { ProcessingPanel, processButton, processField } from "./processing-nodes";
import { placeProcessResults } from "./batch-process-panel";
import { useAssetStore, type TextAsset } from "@/stores/use-asset-store";
import { cloneWorkflowGraph, validateWorkflow, WORKFLOW_SOURCE, EMPTY_WORKFLOW, nodeResult } from "@/lib/canvas/workflow-graph";
import { runWorkflow, cancelProcessing, isProcessing, resultMetadata } from "@/lib/canvas/production-runner";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { MASK_GROW, MASK_FEATHER } from "@/lib/canvas/image-mask";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { WorkflowSettings, WorkflowDefinition, WorkflowParameter } from "@/types/canvas-workflow";

function expandWorkflow(ctx: CanvasNodeContext, workflow: WorkflowSettings) {
    validateWorkflow(workflow);
    const groupId = nanoid();
    const origin = { x: ctx.node.position.x + ctx.node.width + 100, y: ctx.node.position.y + 60 };
    const graph = cloneWorkflowGraph(workflow, origin, groupId);
    const width = Math.max(...graph.nodes.map(node => node.position.x + node.width)) - origin.x + 60;
    const height = Math.max(...graph.nodes.map(node => node.position.y + node.height)) - origin.y + 90;
    ctx.applyOps([
        { type: "add_node", id: groupId, nodeType: CanvasNodeType.Group, title: `${workflow.name} · 编辑内部`, position: { x: origin.x - 30, y: origin.y - 50 }, width, height },
        ...graph.nodes.map(node => ({ type: "add_node" as const, id: node.id, nodeType: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: node.metadata })),
        ...graph.connections.map(edge => ({ type: "connect_nodes" as const, ...edge })),
        { type: "update_node", id: ctx.node.id, metadata: { workflow: { ...workflow, ...graph, expandedGroupId: groupId } } },
        { type: "select_nodes", ids: [ctx.node.id] },
    ]);
}

function collapseWorkflow(ctx: CanvasNodeContext, workflow: WorkflowSettings) {
    const groupId = workflow.expandedGroupId;
    const members = ctx.getNodes().filter(node => node.metadata?.groupId === groupId && node.id !== ctx.node.id);
    if (!groupId || !members.length) throw new Error("展开的分组中没有步骤；可放入节点，或取消展开恢复保存的流程。");
    const ids = new Set(members.map(node => node.id));
    const edges = ctx.getConnections();
    if (edges.some(edge => ids.has(edge.fromNodeId) !== ids.has(edge.toNodeId))) throw new Error("展开步骤与外部存在连线，请先移除跨分组连线再收起。");
    const left = Math.min(...members.map(node => node.position.x)); const top = Math.min(...members.map(node => node.position.y));
    const outputs = workflow.outputs.filter(output => ids.has(output.nodeId));
    const updated: WorkflowSettings = { ...workflow, expandedGroupId: undefined, nodes: members.map(node => ({ ...node, position: { x: node.position.x - left, y: node.position.y - top }, metadata: { ...node.metadata, groupId: undefined } })), connections: edges.filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)), inputs: workflow.inputs.filter(input => ids.has(input.nodeId)), parameters: workflow.parameters.filter(parameter => ids.has(parameter.nodeId)), outputs: outputs.length ? outputs : members.filter(node => !edges.some(edge => edge.fromNodeId === node.id)).map(node => ({ id: node.id, name: node.title, nodeId: node.id })) };
    validateWorkflow(updated);
    ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { workflow: updated, ...resultMetadata(), processResults: [], errorDetails: undefined } }, { type: "delete_node", ids: [...ids, groupId] }, { type: "select_nodes", ids: [ctx.node.id] }]);
}

export function WorkflowPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const workflow = ctx.node.metadata?.workflow || EMPTY_WORKFLOW;
    const results = ctx.node.metadata?.processResults || [];
    const assets = useAssetStore(state => state.assets);
    const library = assets.filter((asset): asset is TextAsset => asset.kind === "text" && asset.source === WORKFLOW_SOURCE);
    const [notice, setNotice] = useState("");
    const [loading, setLoading] = useState(false);
    const busy = isProcessing(ctx) || loading;
    const style = { borderColor: ctx.theme.node.stroke, background: ctx.theme.node.panel };
    const patch = (value: Partial<WorkflowSettings>) => ctx.updateMetadata({ workflow: { ...workflow, ...value }, ...resultMetadata(), processResults: [], errorDetails: undefined });
    const attempt = (action: () => void) => { try { action(); setNotice(""); } catch (error) { setNotice(error instanceof Error ? error.message : "流程操作失败。"); } };
    const save = (asNew: boolean) => attempt(() => {
        if (workflow.expandedGroupId) throw new Error("先收起内部步骤，再保存模板。");
        validateWorkflow(workflow);
        if (!workflow.name.trim()) throw new Error("请填写流程名称。");
        const definition: WorkflowDefinition = { name: workflow.name.trim(), nodes: structuredClone(workflow.nodes), connections: structuredClone(workflow.connections), inputs: structuredClone(workflow.inputs), outputs: structuredClone(workflow.outputs), parameters: workflow.parameters.map(parameter => ({ ...parameter, value: workflow.values[parameter.id] ?? parameter.value })) };
        const store = useAssetStore.getState();
        const existing = !asNew && library.find(asset => asset.id === workflow.assetId);
        const payload = { title: definition.name, data: { content: `${definition.nodes.length} 个步骤` }, metadata: { workflowDefinition: definition } };
        const assetId = existing ? (store.updateAsset(existing.id, payload), existing.id) : store.addAsset({ ...payload, kind: "text", coverUrl: "", tags: ["复用流程"], source: WORKFLOW_SOURCE });
        ctx.updateMetadata({ workflow: { ...workflow, assetId } });
    });
    const load = async (assetId: string) => {
        const asset = library.find(asset => asset.id === assetId);
        const definition = asset?.metadata?.workflowDefinition as WorkflowDefinition | undefined;
        if (!definition) return;
        setLoading(true);
        try {
            validateWorkflow(definition);
            const graph = cloneWorkflowGraph(definition);
            graph.nodes = await hydrateCanvasImages(graph.nodes);
            patch({ ...graph, assetId, bindings: {}, values: {}, expandedGroupId: undefined });
            setNotice("已载入独立副本；其他画布的实例不会跟随修改。");
        } catch (error) { setNotice(error instanceof Error ? error.message : "载入失败。"); }
        finally { setLoading(false); }
    };
    const parameterFields: Record<string, string> = { prompt: "提示词", model: "模型", size: "尺寸", amount: "扩缩像素", radius: "羽化半径" };
    const changeParameter = (id: string, nodeId: string, field: WorkflowParameter["field"]) => {
        const node = workflow.nodes.find(node => node.id === nodeId)!;
        const values = { ...workflow.values }; delete values[id];
        const value = field === "amount" || field === "radius" ? String(node.metadata?.maskSettings?.[field] ?? 4) : String(node.metadata?.[field] || "");
        patch({ parameters: workflow.parameters.map(item => item.id === id ? { ...item, nodeId, field, value } : item), values });
    };
    const parameterNodes = workflow.nodes.filter(node => node.type === CanvasNodeType.Config || node.type === MASK_GROW || node.type === MASK_FEATHER);
    return <ProcessingPanel ctx={ctx} title="复用流程" onClose={onClose}>
        <select aria-label="流程模板库" className={processField} style={style} disabled={busy || !!workflow.expandedGroupId} value={library.some(asset => asset.id === workflow.assetId) ? workflow.assetId : ""} onChange={event => void load(event.target.value)}><option value="" disabled hidden>载入已保存流程</option>{library.map(asset => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select>
        <input aria-label="流程名称" className={processField} style={style} disabled={busy} value={workflow.name} onChange={event => patch({ name: event.target.value })} />
        {!workflow.nodes.length ? <p className="text-xs leading-5">多选图片、文本、生成配置或蒙版步骤，点击选区工具栏“保存为流程”。原节点保留，流程保存独立副本。也可从上方模板库载入。</p> : <>
            <div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-xs">{workflow.nodes.length} 个步骤 · {workflow.connections.length} 条连线</span><button className={processButton} disabled={busy} onClick={() => attempt(() => workflow.expandedGroupId ? collapseWorkflow(ctx, workflow) : expandWorkflow(ctx, workflow))}>{workflow.expandedGroupId ? <Minimize size={14} /> : <Expand size={14} />}{workflow.expandedGroupId ? "收起并更新流程" : "展开内部步骤"}</button></div>
            {workflow.expandedGroupId ? <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>右侧分组内是可编辑的普通节点，可改参数、连线，或把新节点拖入分组。收起会保存分组内容并移除这份编辑副本。<button className={processButton} disabled={busy} onClick={() => attempt(() => { const groupId = workflow.expandedGroupId!; const members = ctx.getNodes().filter(node => node.metadata?.groupId === groupId); ctx.applyOps([{ type: "delete_node", ids: [groupId, ...members.map(node => node.id)] }, { type: "update_node", id: ctx.node.id, metadata: { workflow: { ...workflow, expandedGroupId: undefined } } }]); })}>取消展开编辑</button></p> : null}
            <fieldset disabled={busy || !!workflow.expandedGroupId} className="space-y-3 disabled:opacity-60">
                <div className="flex items-center justify-between text-xs"><strong>公开输入</strong><button type="button" className={processButton} onClick={() => { const node = workflow.nodes.find(node => [CanvasNodeType.Image, CanvasNodeType.Text].includes(node.type as CanvasNodeType) && !workflow.inputs.some(input => input.nodeId === node.id)); if (node) patch({ inputs: [...workflow.inputs, { id: nanoid(), nodeId: node.id, name: node.title, kind: node.type === CanvasNodeType.Text ? 'text' : 'image' }] }); else setNotice('没有尚未公开的图片／文本输入步骤。'); }}><Plus size={14} />公开输入</button></div>
                {workflow.inputs.map(input => <div key={input.id} className="grid grid-cols-[1fr_1fr_auto] gap-2"><input aria-label={`输入名称 ${input.name}`} className={processField} style={style} value={input.name} onChange={event => patch({ inputs: workflow.inputs.map(item => item.id === input.id ? { ...item, name: event.target.value } : item) })} /><select aria-label={`流程输入 ${input.name}`} className={processField} style={style} value={ctx.getUpstream().some(node => node.id === workflow.bindings[input.id] && nodeResult(node)?.kind === input.kind) ? workflow.bindings[input.id] : workflow.bindings[input.id] ? "" : "__default__"} onChange={event => patch({ bindings: { ...workflow.bindings, [input.id]: event.target.value === "__default__" ? "" : event.target.value } })}><option value="" disabled hidden>绑定已失效，请重选</option><option value="__default__">使用内部默认值</option>{ctx.getUpstream().filter(node => nodeResult(node)?.kind === input.kind).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select><button className={processButton} type="button" aria-label={`移除输入 ${input.name}`} onClick={() => patch({ inputs: workflow.inputs.filter(item => item.id !== input.id) })}><X size={14} /></button></div>)}
                <div className="flex items-center justify-between text-xs"><strong>公开输出</strong><button type="button" className={processButton} onClick={() => { const node = workflow.nodes.find(node => !workflow.outputs.some(output => output.nodeId === node.id)); if (node) patch({ outputs: [...workflow.outputs, { id: nanoid(), name: node.title, nodeId: node.id }] }); }}><Plus size={14} />添加输出</button></div>
                {workflow.outputs.map(output => <div key={output.id} className="grid grid-cols-[1fr_1fr_auto] gap-2"><input aria-label={`输出名称 ${output.name}`} className={processField} style={style} value={output.name} onChange={event => patch({ outputs: workflow.outputs.map(item => item.id === output.id ? { ...item, name: event.target.value } : item) })} /><select aria-label={`输出步骤 ${output.name}`} className={processField} style={style} value={workflow.nodes.some(node => node.id === output.nodeId) ? output.nodeId : ""} onChange={event => patch({ outputs: workflow.outputs.map(item => item.id === output.id ? { ...item, nodeId: event.target.value } : item) })}><option value="" disabled hidden>选择步骤</option>{workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select><button type="button" className={processButton} aria-label={`移除输出 ${output.name}`} onClick={() => patch({ outputs: workflow.outputs.filter(item => item.id !== output.id) })}><X size={14} /></button></div>)}
                <div className="flex items-center justify-between text-xs"><strong>公开参数</strong><button type="button" className={processButton} disabled={!parameterNodes.length} onClick={() => { const node = parameterNodes[0]; const field = node.type === MASK_GROW ? "amount" : node.type === MASK_FEATHER ? "radius" : "prompt"; patch({ parameters: [...workflow.parameters, { id: nanoid(), name: node.title, nodeId: node.id, field, value: String(field === 'prompt' ? node.metadata?.prompt || '' : node.metadata?.maskSettings?.[field] ?? 4) }] }); }}><Plus size={14} />公开参数</button></div>
                {workflow.parameters.map(parameter => <div key={parameter.id} className="space-y-2 border-t pt-2" style={{ borderColor: ctx.theme.node.stroke }}><div className="grid grid-cols-[1fr_1fr_110px_auto] gap-2"><input aria-label="参数名称" className={processField} style={style} value={parameter.name} onChange={event => patch({ parameters: workflow.parameters.map(item => item.id === parameter.id ? { ...item, name: event.target.value } : item) })} /><select aria-label="参数步骤" className={processField} style={style} value={parameterNodes.some(node => node.id === parameter.nodeId) ? parameter.nodeId : ""} onChange={event => { const node = parameterNodes.find(node => node.id === event.target.value)!; const field = node.type === MASK_GROW ? 'amount' : node.type === MASK_FEATHER ? 'radius' : 'prompt'; changeParameter(parameter.id, node.id, field); }}><option value="" disabled hidden>选择步骤</option>{parameterNodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select><select aria-label="参数字段" className={processField} style={style} value={parameter.field} onChange={event => changeParameter(parameter.id, parameter.nodeId, event.target.value as WorkflowParameter['field'])}>{(workflow.nodes.find(node => node.id === parameter.nodeId)?.type === CanvasNodeType.Config ? ['prompt', 'model', 'size'] : [workflow.nodes.find(node => node.id === parameter.nodeId)?.type === MASK_GROW ? 'amount' : 'radius']).map(field => <option key={field} value={field}>{parameterFields[field]}</option>)}</select><button type="button" className={processButton} aria-label={`移除参数 ${parameter.name}`} onClick={() => patch({ parameters: workflow.parameters.filter(item => item.id !== parameter.id) })}><X size={14} /></button></div><input aria-label={`参数值 ${parameter.name}`} className={processField} style={style} value={workflow.values[parameter.id] ?? parameter.value} onChange={event => patch({ values: { ...workflow.values, [parameter.id]: event.target.value } })} /></div>)}
            </fieldset>
            <div className="flex flex-wrap gap-2"><button className={processButton} disabled={busy || !!workflow.expandedGroupId} onClick={() => void runWorkflow(ctx)}><Play size={14} />运行流程</button><button className={processButton} disabled={busy || !!workflow.expandedGroupId} onClick={() => save(false)}><Save size={14} />保存模板</button>{workflow.assetId ? <button className={processButton} disabled={busy || !!workflow.expandedGroupId} onClick={() => save(true)}>另存模板</button> : null}{busy && !loading ? <button className={processButton} onClick={() => cancelProcessing(ctx)}>取消运行</button> : null}</div>
            <p className="text-xs leading-5" style={{ color: ctx.theme.node.muted }}>按连线先后运行输出依赖的步骤，共用步骤只执行一次。可执行图片／文本生成与蒙版处理；连接外部来源后为每个输入选择绑定，留空使用保存的默认快照。</p>
            {results.length ? <div className="space-y-2"><div className="flex items-center justify-between text-xs"><strong>流程结果</strong><button className={processButton} onClick={() => placeProcessResults(ctx, results)}>全部放到画布</button></div>{results.map(result => <div key={result.id} className="flex items-center gap-2 text-xs">{result.kind === 'image' ? <img src={result.content} alt={result.title} className="h-12 w-12 rounded object-cover" /> : null}<span className="min-w-0 flex-1 truncate">{result.title}{result.kind === 'text' ? `：${result.content}` : ''}</span><button className={processButton} aria-pressed={ctx.node.metadata?.selectedProcessResultId === result.id} onClick={() => ctx.updateMetadata({ ...resultMetadata(result), status: "success" })}>设为输出</button></div>)}</div> : null}
        </>}
        {notice ? <p className="text-xs leading-5" role="status">{notice}</p> : null}
    </ProcessingPanel>;
}
