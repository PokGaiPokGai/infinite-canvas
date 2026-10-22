import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_INPUT_ROLES, canvasInputRoleLabel, isImageInputNode } from "@/lib/canvas/canvas-input-role";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type Position } from "@/types/canvas";

export function ConnectionRoleBadge({
    connection,
    from,
    to,
    unavailableReason,
    selected,
    zoom,
    slot,
    onSelect,
    onChange,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    unavailableReason: string | null;
    selected: boolean;
    zoom: number;
    slot: number;
    onSelect: () => void;
    onChange: (patch: Pick<CanvasConnection, "role" | "instruction">) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    const [instruction, setInstruction] = useState(connection.instruction || "");
    const rootRef = useRef<HTMLDivElement>(null);
    const latestRef = useRef({ instruction, original: connection.instruction || "", onChange });
    latestRef.current = { instruction, original: connection.instruction || "", onChange };
    useEffect(() => {
        if (!open) return;
        let start: { id: number; x: number; y: number; outside: boolean } | null = null;
        const outside = (target: EventTarget | null) => !(target instanceof Node && rootRef.current?.contains(target));
        const close = () => {
            setOpen(false);
            const { instruction: draft, original, onChange: save } = latestRef.current;
            if (draft.trim() !== original) save({ instruction: draft.trim() });
        };
        const pointerDown = (event: PointerEvent) => {
            start = { id: event.pointerId, x: event.clientX, y: event.clientY, outside: outside(event.target) };
        };
        const pointerUp = (event: PointerEvent) => {
            const pressed = start;
            if (pressed?.id !== event.pointerId) return;
            start = null;
            if (pressed?.outside && outside(event.target) && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) <= 4) close();
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            close();
        };
        window.addEventListener("pointerdown", pointerDown, true);
        window.addEventListener("pointerup", pointerUp, true);
        window.addEventListener("keydown", keyDown, true);
        return () => {
            window.removeEventListener("pointerdown", pointerDown, true);
            window.removeEventListener("pointerup", pointerUp, true);
            window.removeEventListener("keydown", keyDown, true);
        };
    }, [open]);
    if (to.type !== CanvasNodeType.Config || !isImageInputNode(from)) return null;

    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    const t = 0.72 - (slot % 4) * 0.08;
    const inverse = 1 - t;
    const x = inverse ** 3 * startX + 3 * inverse ** 2 * t * (startX + curvature) + 3 * inverse * t ** 2 * (endX - curvature) + t ** 3 * endX;
    const y = inverse ** 3 * startY + 3 * inverse ** 2 * t * startY + 3 * inverse * t ** 2 * endY + t ** 3 * endY + Math.floor(slot / 4) * 28 / zoom;
    const role = connection.role || "reference";
    const roleLabel = canvasInputRoleLabel(role);

    return (
        <div ref={rootRef} className="absolute" style={{ left: x, top: y, zIndex: open || selected ? 60 : 11, transform: `translate(-50%, -50%) scale(${1 / zoom})`, transformOrigin: "center" }}>
            {open ? (
                <div role="dialog" aria-label="图片用途" data-canvas-no-zoom className="absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-lg border p-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                    <div className="mb-2 border-b pb-2 text-sm font-medium" style={{ borderColor: theme.toolbar.border }}>图片用途</div>
                    <div className="w-56">
                        <div className="grid grid-cols-3 gap-1">
                            {CANVAS_INPUT_ROLES.map((item) => (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                                    style={{ color: theme.node.text, background: role === item.value ? theme.toolbar.activeBg : undefined }}
                                    onClick={() => onChange({ role: item.value, instruction: instruction.trim() })}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <input
                            aria-label="补充图片用途"
                            className="mt-2 w-full rounded border bg-transparent px-2 py-1 text-xs outline-none"
                            style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
                            placeholder="补充说明（可选）"
                            value={instruction}
                            onChange={(event) => setInstruction(event.target.value)}
                            onBlur={() => {
                                if (instruction.trim() !== (connection.instruction || "")) onChange({ instruction: instruction.trim() });
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    onChange({ instruction: instruction.trim() });
                                }
                            }}
                        />
                        <p className="mb-0 mt-2 text-xs" style={{ color: theme.node.muted }}>用途表达输入意图，具体支持取决于生成渠道；“蒙版描述”不执行像素级遮罩。</p>
                    </div>
                </div>
            ) : null}
            <button
                type="button"
                data-canvas-no-zoom
                aria-expanded={open}
                aria-label={`设置图片用途：${roleLabel}${unavailableReason ? `；暂不可用：${unavailableReason}` : ""}`}
                title={unavailableReason || "点击设置这条图片连接的用途"}
                className="whitespace-nowrap rounded-md border px-2 py-1 text-[11px] leading-none"
                style={{ background: theme.toolbar.panel, borderColor: unavailableReason ? theme.node.muted : selected ? theme.node.activeStroke : theme.toolbar.border, color: unavailableReason ? theme.node.muted : theme.node.text, opacity: unavailableReason ? 0.7 : 1 }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                    if (!open) setInstruction(connection.instruction || "");
                    else if (instruction.trim() !== (connection.instruction || "")) onChange({ instruction: instruction.trim() });
                    setOpen(!open);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
            >
                {roleLabel}
            </button>
        </div>
    );
}

export function ConnectionPath({
    connection,
    from,
    to,
    unavailableReason,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    unavailableReason: string | null;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            ><title>{unavailableReason ? `暂不可用：${unavailableReason}；切回可用模式后自动恢复` : "画布连线"}</title></path>
            <path
                d={pathD}
                stroke={unavailableReason ? theme.node.muted : active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={unavailableReason ? 0.35 : active ? 1 : 0.82}
                strokeDasharray={unavailableReason ? "6 5" : undefined}
                fill="none"
                style={{ filter: active && !unavailableReason ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
