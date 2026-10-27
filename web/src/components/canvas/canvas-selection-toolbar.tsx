import { NodeToolbarAction, nodeToolbarClassName } from "./node-toolbar-action";
import { Group, Ungroup, Layers, Workflow } from "lucide-react";

import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const SELECTION_PAD = 14;

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canStack,
    onStack,
    canWorkflow,
    onWorkflow,
    canGroup,
    canUngroup,
    onGroup,
    onUngroup,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canStack?: boolean;
    onStack?: () => void;
    canWorkflow?: boolean;
    onWorkflow?: () => void;
    canGroup: boolean;
    canUngroup: boolean;
    onGroup: () => void;
    onUngroup: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const showActions = showToolbar && (canWorkflow || canStack || canGroup || canUngroup);

    return (
        <>
            <svg className="pointer-events-none absolute z-[65] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showActions ? (
                <div
                    data-selection-toolbar className={`${nodeToolbarClassName} absolute z-[70] -translate-x-1/2 -translate-y-full overflow-visible`}
                    style={{ left: left + width / 2, top: top - 8 }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {canStack && onStack ? <NodeToolbarAction title="将所选图片收为版本堆叠" icon={<Layers className="size-4" />} onClick={onStack} /> : null}
                    {canWorkflow && onWorkflow ? <NodeToolbarAction title="将所选步骤保存为独立复用流程，保留原节点" icon={<Workflow className="size-4" />} onClick={onWorkflow} /> : null}
                    {canGroup ? <NodeToolbarAction title={t("canvas.nodeToolbar.groupTitle")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <NodeToolbarAction title={t("canvas.nodeToolbar.ungroupTitle")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                </div>
            ) : null}
        </>
    );
}
