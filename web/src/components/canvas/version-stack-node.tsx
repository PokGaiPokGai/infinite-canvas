import { Layers, Star, UnfoldVertical, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { VERSION_STACK, STACK_RELEASE } from "@/lib/canvas/version-stack";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

const button = "inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
function StackContent({ ctx }: { ctx: CanvasNodeContext }) {
    const inputs = ctx.node.metadata?.stackInputs || [];
    const selected = inputs.find(input => input.nodeId === ctx.node.metadata?.versionStack?.selectedId);
    const cover = ctx.node.metadata?.content || inputs.find(input => input.content)?.content;
    return <div className="relative h-full w-full overflow-hidden rounded-[inherit]" style={{ background: ctx.theme.node.panel }}>
        {cover ? <img src={cover} alt={selected?.title || "候选版本"} draggable={false} className="pointer-events-none h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-sm" style={{ color: ctx.theme.node.muted }}>暂无可用图片</div>}
        <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text }}><Layers size={14} />{inputs.length} 个版本</span>
    </div>;
}
function StackPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const settings = ctx.node.metadata?.versionStack;
    const inputs = ctx.node.metadata?.stackInputs || [];
    const release = (memberId?: string) => ctx.emit(STACK_RELEASE, { projectId: ctx.projectId, stackId: ctx.node.id, memberId });
    return <div data-version-stack-panel className="rounded-2xl border p-4" style={{ background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }} data-canvas-no-zoom>
        <div className="mb-3 flex items-center gap-2"><Layers size={16} /><span className="flex-1 text-sm font-medium">版本堆叠 · {inputs.length} 张</span><button className={button} onClick={() => release()}><UnfoldVertical size={14} />全部拆开</button><button className={button} aria-label="关闭版本堆叠面板" onClick={onClose}><X size={16} /></button></div>
        <div className="grid max-h-80 grid-cols-3 gap-3 overflow-y-auto">
            {inputs.map(input => {
                const selected = settings?.selectedId === input.nodeId;
                const ready = !!input.content && input.status !== "loading" && input.status !== "error";
                return <div key={input.nodeId} className="min-w-0 rounded-xl border p-1" style={{ borderColor: selected ? ctx.theme.node.activeStroke : ctx.theme.node.stroke }}>
                    <button aria-label={`选定版本：${input.title}`} aria-pressed={selected} disabled={!ready} className="block aspect-[4/3] w-full overflow-hidden rounded-lg disabled:opacity-40" onClick={() => settings && ctx.updateMetadata({ versionStack: { ...settings, selectedId: input.nodeId } })}>
                        {input.content ? <img src={input.content} alt={input.title} draggable={false} className="h-full w-full object-contain" /> : <span className="text-xs">图片未就绪</span>}
                    </button>
                    <div className="truncate px-1 pt-2 text-xs" title={input.title}>{input.title}</div>
                    <div className="flex items-center justify-between"><span className="inline-flex items-center gap-1 px-1 text-[11px]" style={{ color: ctx.theme.node.muted }}>{selected ? <><Star size={12} />选定输出</> : "候选"}</span><button className={button} aria-label={`移出版本：${input.title}`} onClick={() => release(input.nodeId)}>移出</button></div>
                </div>;
            })}
        </div>
        <p className="mt-3 text-xs leading-5" style={{ color: ctx.theme.node.muted }}>{ctx.node.metadata?.content ? "点击缩略图选定下游使用的原图。" : "尚无有效输出，请选定一个可用版本。"} 原图与原连线保留；拆开时恢复展示。删除堆叠容器也会恢复原节点。</p>
    </div>;
}
export function registerVersionStackNode() {
    registerNodeDefinitions([{ type: VERSION_STACK, title: "版本堆叠", icon: <Layers size={16} />, defaultSize: { width: 340, height: 260 }, showInCreateMenu: false, hasTargetHandle: false, autoOpenPanel: true, Content: StackContent, Panel: StackPanel, resource: node => node.metadata?.status === "success" && node.metadata.content ? { kind: "image", url: node.metadata.content } : null }], "version-stack");
}
