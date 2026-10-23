import { useRef, useState } from "react";
import { Columns2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasPanel, useCanvasPanel } from "./canvas-panel";
import { IMAGE_COMPARE } from "@/lib/canvas/image-compare";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

const buttonClass = "inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed";

function CompareContent({ ctx }: { ctx: CanvasNodeContext }) {
    const panel = useCanvasPanel({ closeOnEscape: true });
    const settings = ctx.node.metadata?.comparison || {};
    const inputs = ctx.node.metadata?.comparisonInputs || [];
    const mode = settings.mode || "slider";
    const a = inputs.find(input => input.nodeId === settings.aId);
    const b = inputs.find(input => input.nodeId === settings.bId);
    const [split, setSplit] = useState(50);
    const [view, setView] = useState<"a" | "b">("a");
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [failed, setFailed] = useState<Set<string>>(() => new Set());
    const drag = useRef<{ id: number; x: number; y: number; offset: typeof offset } | null>(null);
    const ready = !!a?.content && !!b?.content && !failed.has(a.content) && !failed.has(b.content);
    const patch = (value: Partial<typeof settings>) => ctx.updateMetadata({ comparison: { ...settings, ...value } });
    const resetView = () => { setZoom(1); setOffset({ x: 0, y: 0 }); };
    const changeZoom = (factor: number) => setZoom(value => Number.isFinite(value * factor) && value * factor > 0 ? Math.max(1, value * factor) : value);
    const activeStyle = { background: ctx.theme.toolbar.activeBg, color: ctx.theme.toolbar.activeText };
    const clampOffset = (x: number, y: number) => {
        const width = ctx.node.width - 4, height = ctx.node.height - 4;
        const limits = [a, b].map(input => {
            const w = input?.naturalWidth || width, h = input?.naturalHeight || height;
            const cover = Math.max(width / w, height / h) * zoom;
            return { x: Math.max(0, (w * cover - width) / 2), y: Math.max(0, (h * cover - height) / 2) };
        });
        const maxX = Math.min(...limits.map(limit => limit.x)), maxY = Math.min(...limits.map(limit => limit.y));
        return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    };
    const position = clampOffset(offset.x, offset.y);
    const image = (side: "a" | "b") => {
        const input = side === "a" ? a : b;
        return input?.content ? <img key={input.content} src={input.content} alt={`对比图 ${side.toUpperCase()}：${input.title}`} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover" style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} onError={() => setFailed(previous => new Set(previous).add(input.content!))} /> : null;
    };
    return <CanvasPanel panel={panel} className="relative h-full w-full rounded-[inherit]" style={{ background: ctx.theme.node.panel, color: ctx.theme.node.text }}>
        <div className="relative h-full w-full overflow-hidden rounded-[inherit]" data-canvas-no-zoom data-compare-viewport style={{ backgroundColor: ctx.theme.canvas.background, cursor: ready ? "grab" : undefined }} onMouseDown={event => { if (ready) event.stopPropagation(); }} onClick={event => { event.stopPropagation(); panel.show("settings", event); }} onPointerDown={event => { if (!ready || event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset }; }} onPointerMove={event => { const current = drag.current; if (!current || current.id !== event.pointerId) return; setOffset({ x: current.offset.x + (event.clientX - current.x) / ctx.scale, y: current.offset.y + (event.clientY - current.y) / ctx.scale }); }} onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            {ready ? <>{mode === "toggle" ? image(view) : <>{image("a")}<div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)`, backgroundColor: ctx.theme.canvas.background }}>{image("b")}</div><div data-compare-divider className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2" style={{ left: `${split}%`, background: ctx.theme.node.activeStroke }} /></>}</> : <div className="grid h-full place-items-center px-5 text-center text-xs" style={{ color: ctx.theme.node.muted }}>连接两张图片，在下方设置中选择 A 与 B</div>}
        </div>
        <CanvasPanel panel={panel} className="absolute inset-x-0 top-full z-40 pt-3" data-canvas-no-zoom>
            <div data-compare-slider-bar className="relative h-6 w-full" style={{ opacity: ready ? 1 : 0.4 }}>
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px" style={{ background: ctx.theme.node.muted }} />
                <div data-compare-thumb className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ left: `${split}%`, background: ctx.theme.node.panel, borderColor: ctx.theme.node.activeStroke }} />
                <input type="range" min={0} max={100} value={split} aria-label="对比滑杆" disabled={!ready} className="absolute -left-2 top-0 m-0 h-full cursor-grab active:cursor-grabbing appearance-none opacity-0 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-0" style={{ width: "calc(100% + 16px)" }} onChange={event => { setSplit(Number(event.target.value)); if (mode !== "slider") patch({ mode: "slider" }); }} />
            </div>
            {panel.isOpen ? <div data-compare-settings className="mt-3 rounded-2xl border p-2" style={{ background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke }}>
                <div className="flex items-center justify-between px-2 py-1"><span className="text-xs font-medium">图片比较</span><button aria-label="关闭图片比较设置" className={buttonClass} onClick={panel.close}><X size={14} /></button></div>
        <div className="flex flex-wrap gap-2 p-2" data-canvas-no-zoom onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
            {(["a", "b"] as const).map(side => <label key={side} className="flex min-w-0 flex-1 items-center gap-1 text-xs"><span>{side.toUpperCase()}</span><select aria-label={`对比 ${side.toUpperCase()} 来源`} className="min-w-0 flex-1 rounded border px-1 py-1 outline-none" style={{ background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke }} value={inputs.some(input => input.nodeId === settings[`${side}Id`]) ? settings[`${side}Id`] : ""} onChange={event => { patch({ [`${side}Id`]: event.target.value }); resetView(); }}><option value="" disabled hidden>选择已连接图片</option>{inputs.map(input => <option key={input.nodeId} value={input.nodeId}>{input.title}{!input.content ? "（未就绪）" : ""}</option>)}</select></label>)}
        </div>
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2" data-canvas-no-zoom onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
            {(["slider", "toggle"] as const).map(value => <button key={value} className={buttonClass} aria-pressed={mode === value} style={mode === value ? activeStyle : undefined} onClick={() => patch({ mode: value })}>{value === "slider" ? "滑杆" : "切换"}</button>)}
            {mode === "toggle" ? <button className={buttonClass} disabled={!ready} onClick={() => setView(value => value === "a" ? "b" : "a")}>当前 {view.toUpperCase()} · 查看 {view === "a" ? "B" : "A"}</button> : null}
            <div className="ml-auto flex items-center gap-0.5"><button className={buttonClass} aria-label="缩小对比图片" disabled={!ready} onClick={() => changeZoom(1 / 1.25)}><Minus size={14} /></button><span className="min-w-10 text-center text-[11px]" aria-label="对比缩放比例">{Math.round(zoom * 100)}%</span><button className={buttonClass} aria-label="放大对比图片" disabled={!ready} onClick={() => changeZoom(1.25)}><Plus size={14} /></button><button className={buttonClass} aria-label="重置对比视图" onClick={resetView}><RotateCcw size={14} /></button></div>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-2" data-canvas-no-zoom onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
            {(["a", "b"] as const).map(side => { const input = side === "a" ? a : b; return <button key={side} className={buttonClass} aria-pressed={settings.selected === side} disabled={!input?.content || failed.has(input.content)} style={settings.selected === side ? activeStyle : undefined} onClick={() => patch({ selected: side })}>{settings.selected === side ? `已选 ${side.toUpperCase()} 输出` : `选 ${side.toUpperCase()} 为输出`}</button>; })}
            <span className="ml-auto text-[11px]" style={{ color: ctx.theme.node.muted }}>{ctx.node.metadata?.content ? "输出原图" : "暂无有效输出"}</span>
            <p className="w-full text-[10px] leading-4" style={{ color: ctx.theme.node.muted }}>{[a, b].some(input => input?.content && failed.has(input.content)) ? "图片加载失败，请检查来源。" : "A 左 / B 右 · 等比铺满（裁边） · 拖动平移 · 缩放不改变输出"}</p>
        </div>
            </div> : null}
        </CanvasPanel>
    </CanvasPanel>;
}

export function registerImageCompareNode() {
    registerNodeDefinitions([{ type: IMAGE_COMPARE, title: "图片比较", icon: <Columns2 size={16} />, description: "比较两张图片，选定原图作为下游输出", defaultSize: { width: 480, height: 400 }, defaultMetadata: { comparison: { mode: "slider" } }, hidePanel: true, Content: CompareContent, resource: node => node.metadata?.status === "success" && node.metadata.content ? { kind: "image", url: node.metadata.content } : null }], "image-compare");
}
