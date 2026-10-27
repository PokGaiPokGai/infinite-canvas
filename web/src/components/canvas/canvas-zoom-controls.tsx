import type { ReactNode } from "react";
import { ChevronsLeft, ChevronsRight, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasZoomControlsProps = {
    scale: number;
    onScaleChange: (scale: number) => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
    children: ReactNode;
};

export function CanvasZoomControls({ scale, onScaleChange, isMiniMapOpen, onToggleMiniMap, children }: CanvasZoomControlsProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonClass = "flex h-9 shrink-0 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current";
    return (
        <div
            data-canvas-navigation
            className="absolute bottom-0 left-0 z-50 overflow-hidden rounded-tr-lg transition-[width,height] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: isMiniMapOpen ? 164 : 90, height: isMiniMapOpen ? 136 : 36, background: theme.toolbar.panel, color: theme.toolbar.item }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="flex h-9 items-center justify-between px-1">
                {isMiniMapOpen && <button type="button" className={`${buttonClass} w-6`} aria-label="缩小" onClick={() => onScaleChange(scale / 1.2)}><Minus className="size-4" /></button>}
                <button type="button" className={`${buttonClass} min-w-12 text-canvas-caption tabular-nums`} title="恢复 100%" aria-label="恢复缩放至 100%" onClick={() => onScaleChange(1)}>
                    {Math.round(scale * 100)}%
                </button>
                {isMiniMapOpen && <button type="button" className={`${buttonClass} w-6`} aria-label="放大" onClick={() => onScaleChange(scale * 1.2)}><Plus className="size-4" /></button>}
                <button type="button" className={`${buttonClass} w-6`} style={{ color: theme.node.faint }} aria-expanded={isMiniMapOpen} aria-label={isMiniMapOpen ? t("canvas.miniMapClose") : t("canvas.miniMapOpen")} onClick={onToggleMiniMap}>
                    {isMiniMapOpen ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
                </button>
            </div>
            <div aria-hidden={!isMiniMapOpen} className={`w-[164px] transition-opacity duration-200 motion-reduce:transition-none ${isMiniMapOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
                {children}
            </div>
        </div>
    );
}
