import type { ReactNode } from "react";
import { Tooltip } from "antd";

// One presentation for single-node, multi-selection and tool-customization previews.
export const nodeToolbarClassName = "flex h-12 items-center rounded-[18px] border border-black/10 bg-white text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]";

export function NodeToolbarAction({ title, icon, onClick, active = false, danger = false, tabIndex }: {
    title: string;
    icon: ReactNode;
    onClick?: () => void;
    active?: boolean;
    danger?: boolean;
    tabIndex?: number;
}) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: "var(--text-canvas-ui)", fontWeight: 500 } }}>
            <button type="button" className={`group flex h-12 w-11 shrink-0 items-center justify-center rounded-[18px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-current ${danger ? "text-[#ef4444]" : ""}`} onClick={onClick} aria-label={title} tabIndex={tabIndex}>
                <span className={`flex size-9 items-center justify-center rounded-lg transition group-hover:bg-[#f0f0f1] [&_svg]:size-4 ${active ? "bg-[#eeeeef]" : ""}`}>
                    {icon}
                </span>
            </button>
        </Tooltip>
    );
}
