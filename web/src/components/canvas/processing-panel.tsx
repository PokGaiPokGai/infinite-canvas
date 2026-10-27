import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

export const processButton = "inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-canvas-ui hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
export const processField = "w-full min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-canvas-ui outline-none";
export function ProcessingPanel({ ctx, title, onClose, children }: { ctx: CanvasNodeContext; title: string; onClose: () => void; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const rect = useCanvasPopoverAnchor(ref, true);
    const area = ref.current?.closest("section")?.getBoundingClientRect();
    const left = Math.max(12, (area?.left || 0) + 12);
    const right = Math.min(window.innerWidth, area?.right ?? window.innerWidth) - 12;
    const width = Math.min(640, right - left);
    const naturalLeft = (rect?.left || 0) + ((rect?.width || 600) - width) / 2;
    const shift = rect ? Math.max(left, Math.min(naturalLeft, right - width)) - naturalLeft : 0;
    const bottom = (area?.bottom ?? window.innerHeight) - 12;
    return <div ref={ref} className="w-full"><div data-processing-panel className="canvas-ui mx-auto space-y-3 overflow-y-auto rounded-2xl border p-4" style={{ width, transform: `translateX(${shift}px)`, maxHeight: Math.max(160, bottom - (rect?.top ?? 12)), background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }} data-canvas-no-zoom>
        <header className="flex items-center gap-2"><strong className="flex-1 text-canvas-title font-semibold">{title}</strong><button className={processButton} aria-label="关闭处理面板" onClick={onClose}><X size={16} /></button></header>
        {children}
        {ctx.node.metadata?.errorDetails ? <p role="alert" className="break-words text-canvas-caption leading-5">{ctx.node.metadata.errorDetails}</p> : null}
    </div></div>;
}
