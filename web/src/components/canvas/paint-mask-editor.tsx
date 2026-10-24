// Draft interaction and toolbar adapted from Suavis Notes Draw (MIT).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Eraser, MousePointer2, Pencil, Redo2, Undo2 } from "lucide-react";
import { CanvasPanel, useCanvasPanel } from "./canvas-panel";
import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";
import { DRAW_WEIGHTS, maskStrokeBounds, maskStrokeSegments, maskStrokeTouches } from "@/lib/canvas/paint-mask";
import type { MaskPoint, MaskStroke, PaintMaskDrawing } from "@/types/paint-mask";
import type { CanvasTheme } from "@/lib/canvas-theme";
import styles from "./paint-mask-editor.module.css";

type Tool = "pen" | "select" | "eraser";
type Props = {
    initial: PaintMaskDrawing;
    image: string;
    theme: CanvasTheme;
    hostRef: RefObject<HTMLDivElement | null>;
    saving: boolean;
    error: string;
    onCancel: () => void;
    onSave: (drawing: PaintMaskDrawing) => void;
};
const colors = ["#ffffff", "#323b4a", "#62dbc8", "#7cd651", "#ffd14d", "#ff8d48", "#ff5757", "#ff6ed4", "#ad6fff", "#4ebafd", "#5882f8"];

export function PaintMaskStrokes({ strokes, color }: { strokes: MaskStroke[]; color: string }) {
    return <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" opacity={0.4}>{strokes.map(stroke => <g key={stroke.id} data-mask-stroke={stroke.id}>{maskStrokeSegments(stroke).map((segment, index) => <path key={index} d={segment.path} strokeWidth={segment.width} />)}</g>)}</g>;
}

export function PaintMaskEditor({ initial, image, theme, hostRef, saving, error, onCancel, onSave }: Props) {
    const [drawing, setDrawing] = useState(() => structuredClone(initial));
    const current = useRef(drawing);
    const [tool, setTool] = useState<Tool>("pen");
    const [width, setWidth] = useState<number>(DRAW_WEIGHTS[0]);
    const [color, setColor] = useState("#ffffff");
    const [popup, setPopup] = useState<"color" | "width" | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [marquee, setMarquee] = useState<ReturnType<typeof maskStrokeBounds> | null>(null);
    const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
    const past = useRef<MaskStroke[][]>([]), future = useRef<MaskStroke[][]>([]);
    const selectedRef = useRef(selected);
    const layerRef = useRef<SVGGElement>(null);
    const surfaceRef = useRef<SVGSVGElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const cancelGesture = useRef<(() => void) | null>(null);
    const frame = useRef<number | null>(null);
    const space = useRef(false);
    const canvasRef = useRef<HTMLElement | null>(null);
    useLayoutEffect(() => { canvasRef.current = hostRef.current?.closest("section") || null; }, [hostRef]);
    const canvasRect = useCanvasPopoverAnchor(canvasRef, true);
    const panel = useCanvasPanel({ onDismiss: onCancel });
    const dirty = JSON.stringify(drawing.strokes) !== JSON.stringify(initial.strokes);
    const choose = (ids: Set<string>) => { selectedRef.current = ids; setSelected(ids); };
    const renderDraft = () => {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => { frame.current = null; setDrawing({ ...current.current }); });
    };
    const replace = (strokes: MaskStroke[]) => { current.current = { ...current.current, strokes }; setDrawing(current.current); };
    const record = (before: MaskStroke[]) => {
        if (JSON.stringify(before) !== JSON.stringify(current.current.strokes)) { past.current.push(before); future.current = []; }
        setDrawing({ ...current.current });
    };
    const undo = () => {
        cancelGesture.current?.();
        const strokes = past.current.pop();
        if (strokes) { future.current.push(current.current.strokes); replace(strokes); choose(new Set()); }
    };
    const redo = () => {
        cancelGesture.current?.();
        const strokes = future.current.pop();
        if (strokes) { past.current.push(current.current.strokes); replace(strokes); choose(new Set()); }
    };
    const setWeight = (next: number) => {
        if (!Number.isFinite(next) || next <= 0) return;
        setWidth(next);
        if (selectedRef.current.size) {
            const before = current.current.strokes;
            replace(before.map(stroke => selectedRef.current.has(stroke.id) ? { ...stroke, width: next } : stroke));
            record(before);
        }
    };
    const removeSelected = () => {
        const before = current.current.strokes;
        replace(before.filter(stroke => !selectedRef.current.has(stroke.id)));
        choose(new Set()); record(before);
    };
    const save = () => {
        cancelGesture.current?.();
        if (saving) return;
        if (JSON.stringify(current.current.strokes) === JSON.stringify(initial.strokes)) onCancel();
        else onSave(current.current);
    };
    const actions = useRef({ undo, redo, save, onCancel, removeSelected, setWeight, popup, saving });
    useLayoutEffect(() => { actions.current = { undo, redo, save, onCancel, removeSelected, setWeight, popup, saving }; });
    useEffect(() => {
        panel.show("draw");
        surfaceRef.current?.focus();
        return () => { cancelGesture.current?.(); if (frame.current !== null) cancelAnimationFrame(frame.current); };
    }, []);
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            const editable = event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]");
            if (editable && event.key !== "Escape") return;
            event.stopImmediatePropagation();
            const action = actions.current, value = event.key.toLowerCase(), meta = event.ctrlKey || event.metaKey;
            if (event.code === "Space") { event.preventDefault(); space.current = true; }
            else if (value === "escape") { event.preventDefault(); if (action.popup) setPopup(null); else action.save(); }
            else if (action.saving) return;
            else if (meta && value === "z") { event.preventDefault(); if (event.shiftKey) action.redo(); else action.undo(); }
            else if (meta && value === "y") { event.preventDefault(); action.redo(); }
            else if (meta && value === "a") { event.preventDefault(); setTool("select"); choose(new Set(current.current.strokes.map(stroke => stroke.id))); }
            else if (value === "delete" || value === "backspace") { event.preventDefault(); action.removeSelected(); }
            else if (meta && value === "s") { event.preventDefault(); action.save(); }
            else if (!meta) {
                if (value === "d") setTool("pen");
                if (value === "v") setTool("select");
                if (value === "e") setTool("eraser");
                if (/^[1-4]$/.test(value)) action.setWeight(DRAW_WEIGHTS[Number(value) - 1]);
            }
        };
        const up = (event: KeyboardEvent) => { if (event.code === "Space") space.current = false; };
        const blur = () => { space.current = false; cancelGesture.current?.(); };
        window.addEventListener("keydown", key, true);
        window.addEventListener("keyup", up, true);
        window.addEventListener("blur", blur);
        return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", blur); };
    }, []);

    const point = (event: PointerEvent): MaskPoint => {
        const matrix = layerRef.current!.getScreenCTM()!.inverse();
        const value = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
        return { x: value.x, y: value.y, ...(event.pointerType === "pen" ? { p: event.pressure } : {}) };
    };
    const startGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (saving || event.button !== 0 && event.button !== 1 || event.pointerType === "touch" && !event.isPrimary) return;
        event.preventDefault(); event.stopPropagation(); setPopup(null); cancelGesture.current?.(); surfaceRef.current?.focus();
        const before = structuredClone(current.current.strokes), start = point(event.nativeEvent);
        const pan = event.button === 1 || space.current;
        if (!pan && (start.x < 0 || start.y < 0 || start.x > initial.width || start.y > initial.height)) return;
        let previous = start, stroke: MaskStroke | null = null, selecting = false;
        if (!pan && tool === "pen") {
            choose(new Set());
            stroke = { id: crypto.randomUUID(), width, points: [start] };
            current.current = { ...current.current, strokes: [...before, stroke] };
        } else if (!pan && tool === "select") {
            const scale = layerRef.current!.getScreenCTM()!.a;
            const hit = [...before].reverse().find(item => maskStrokeTouches(item, start, start, 4 / scale));
            const selection = new Set(selectedRef.current);
            if (hit) {
                if (event.ctrlKey || event.metaKey || event.shiftKey) { if (selection.has(hit.id)) selection.delete(hit.id); else selection.add(hit.id); }
                else if (!selection.has(hit.id)) { selection.clear(); selection.add(hit.id); }
            } else { if (!event.shiftKey) selection.clear(); selecting = true; }
            choose(selection);
        } else if (!pan) current.current = { ...current.current, strokes: before.filter(item => !maskStrokeTouches(item, start, start)) };
        const initialSelection = new Set(selectedRef.current);
        const initialView = view;
        const origin = { x: event.clientX, y: event.clientY };
        const pointerId = event.pointerId;
        const move = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            const position = point(next);
            if (pan) {
                const rect = surfaceRef.current!.getBoundingClientRect();
                setView({ ...initialView, x: initialView.x + (next.clientX - origin.x) * initial.width / rect.width, y: initialView.y + (next.clientY - origin.y) * initial.height / rect.height });
            } else if (stroke) {
                const samples = next.getCoalescedEvents?.() || [];
                stroke.points.push(...(samples.length ? samples : [next]).map(point));
            } else if (tool === "eraser") current.current.strokes = current.current.strokes.filter(item => !maskStrokeTouches(item, previous, position));
            else if (selecting) {
                const box = { x: Math.min(start.x, position.x), y: Math.min(start.y, position.y), width: Math.abs(start.x - position.x), height: Math.abs(start.y - position.y) };
                const ids = new Set(initialSelection);
                for (const item of before) {
                    const bounds = maskStrokeBounds(item);
                    if (bounds.x <= box.x + box.width && bounds.x + bounds.width >= box.x && bounds.y <= box.y + box.height && bounds.y + bounds.height >= box.y) ids.add(item.id);
                }
                choose(ids); setMarquee(box);
            } else current.current.strokes = before.map(item => selectedRef.current.has(item.id) ? { ...item, points: item.points.map(p => ({ ...p, x: p.x + position.x - start.x, y: p.y + position.y - start.y })) } : item);
            previous = position; renderDraft();
        };
        const cleanup = () => {
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
            cancelGesture.current = null; setMarquee(null);
        };
        const abort = () => { cleanup(); replace(before); if (pan) setView(initialView); };
        const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) abort(); };
        const up = (next: PointerEvent) => { if (next.pointerId === pointerId) { cleanup(); if (!pan) record(before); } };
        cancelGesture.current = abort;
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
        renderDraft();
    };
    const dark = theme.canvas.background === "#181715";
    // Exact neutral tool-strip colours from the supplied Suavis Draw reference.
    const palette = { "--draw-surface": dark ? "#282828" : theme.node.panel, "--draw-text": dark ? "#e8e8e8" : theme.node.text,
        "--draw-hover": dark ? "#3d3d3d" : theme.toolbar.itemHover, "--draw-active": dark ? "#fcfcfc" : theme.node.activeStroke,
        "--draw-divider": dark ? "#3d3d3d" : theme.node.stroke, "--draw-border": dark ? "#4e4e4e" : theme.node.stroke,
        "--draw-disabled": dark ? "#808080" : theme.node.faint, "--draw-disabled-bg": dark ? "#414141" : theme.node.fill,
    } as CSSProperties;
    const bounds = canvasRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const fit = Math.max(0.01, Math.min((bounds.width - 48) / initial.width, (bounds.height - 144) / initial.height));
    const backdropPress = useRef(false);
    const divider = <span className={styles.divider} />;
    return createPortal(<CanvasPanel panel={panel} className={styles.focus} role="dialog" aria-modal="true" aria-label="专注绘制蒙版" data-mask-focus-editor data-canvas-no-zoom style={{ ...palette, left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }} onPointerDown={event => { backdropPress.current = event.button === 0 && event.target === event.currentTarget; }} onClick={event => { if (backdropPress.current && event.target === event.currentTarget) onCancel(); backdropPress.current = false; }} onDoubleClick={event => event.stopPropagation()}>
        <div className={styles.stage} style={{ width: initial.width * fit, height: initial.height * fit }}>
            <svg ref={surfaceRef} data-mask-paint-surface role="application" aria-label="蒙版绘图区" tabIndex={-1} viewBox={`0 0 ${initial.width} ${initial.height}`} className="h-full w-full touch-none outline-none" style={{ cursor: tool === "pen" ? "crosshair" : tool === "eraser" ? "cell" : "default", background: theme.canvas.background }} onPointerDown={startGesture} onContextMenu={event => event.preventDefault()} onWheel={event => {
                event.stopPropagation();
                if (cancelGesture.current || !event.deltaY) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = (event.clientX - rect.left) * initial.width / rect.width, y = (event.clientY - rect.top) * initial.height / rect.height;
                setView(previous => {
                    const zoom = Math.max(0.25, Math.min(8, previous.zoom * Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.002)));
                    const ratio = zoom / previous.zoom;
                    return { zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio };
                });
            }}>
                <g ref={layerRef} transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                    <image href={image} width={initial.width} height={initial.height} />
                    <PaintMaskStrokes strokes={drawing.strokes} color={color} />
                    {drawing.strokes.filter(stroke => selected.has(stroke.id)).map(stroke => <rect key={stroke.id} {...maskStrokeBounds(stroke)} fill="none" stroke={theme.node.activeStroke} strokeWidth={1 / view.zoom} strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`} />)}
                    {marquee ? <rect {...marquee} fill={theme.canvas.selectionFill} stroke={theme.node.activeStroke} strokeWidth={1 / view.zoom} /> : null}
                </g>
            </svg>
        </div>
        <div className={styles.editor}>
            <div ref={toolbarRef} role="toolbar" aria-label="蒙版绘制工具" className={styles.toolbar}>
                {([{ id: "pen", label: "画笔", Icon: Pencil }, { id: "select", label: "选择笔画", Icon: MousePointer2 }, { id: "eraser", label: "橡皮", Icon: Eraser }] as const).map(({ id, label, Icon }) => <button key={id} className={styles.tool} title={`${label} (${id === "pen" ? "D" : id === "select" ? "V" : "E"})`} aria-label={label} aria-pressed={tool === id} disabled={saving} onClick={() => { setTool(id); setPopup(null); }}><Icon /></button>)}
                {divider}
                <button className={styles.tool} title="标注显示颜色（不改变黑白蒙版输出）" aria-label="标注显示颜色" aria-expanded={popup === "color"} onClick={() => setPopup(popup === "color" ? null : "color")}><span className={styles.swatch} style={{ background: color }} /></button>
                <button className={styles.tool} title="笔触大小 (1–4)" aria-label="笔触大小" aria-expanded={popup === "width"} disabled={saving} onClick={() => setPopup(popup === "width" ? null : "width")}><svg viewBox="0 0 24 24" fill="none"><path d="M15 4Q2 13 6 15L16 11Q10 20 19 18" stroke="currentColor" strokeWidth={width <= 3 ? 1.5 : width <= 8 ? 3 : width <= 18 ? 5 : 8} strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                {divider}
                <button className={styles.tool} aria-label="撤销笔画" title="撤销 (Ctrl/Cmd+Z)" disabled={saving || !past.current.length} onClick={undo}><Undo2 /></button>
                <button className={styles.tool} aria-label="重做笔画" title="重做 (Ctrl/Cmd+Shift+Z)" disabled={saving || !future.current.length} onClick={redo}><Redo2 /></button>
                <button className={`${styles.tool} ${styles.cancel}`} onClick={onCancel}>{dirty ? "放弃" : "取消"}</button>
                <button className={`${styles.tool} ${styles.save}`} disabled={!dirty || saving} onClick={save}>{saving ? "保存中" : "保存"}</button>
            </div>
            {popup ? <div className={styles.popup} role="group" aria-label={popup === "color" ? "标注颜色" : "笔触设置"}>
                {popup === "color" ? <><div className={styles.colors}>{colors.map(value => <button key={value} title={value} aria-label={`标注颜色 ${value}`} aria-pressed={color === value} className={styles.color} style={{ background: value }} onClick={() => { setColor(value); setPopup(null); }} />)}</div><p>仅改变预览，输出仍是黑白蒙版</p></> : <><div className={styles.weights}>{DRAW_WEIGHTS.map((value, index) => <button key={value} className={styles.tool} aria-label={`笔触 ${index + 1}（${value} 像素）`} aria-pressed={width === value} onClick={() => { setWeight(value); setPopup(null); }}><svg viewBox="0 0 24 24" fill="none"><path d="M15 4Q2 13 6 15L16 11Q10 20 19 18" stroke="currentColor" strokeWidth={[1.5, 3, 5, 8][index]} strokeLinecap="round" strokeLinejoin="round" /></svg></button>)}</div><label className={styles.widthField}>像素<input type="number" min={1} value={width} aria-label="笔刷像素大小" onChange={event => setWeight(Number(event.target.value))} /></label></>}
            </div> : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
    </CanvasPanel>, document.body);
}
