import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, ImageIcon, List, Music2, Search, Settings2, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import { CanvasNodeType, type ConnectionHandle, type Position } from "@/types/canvas";
import { CANVAS_NODE_CATEGORIES, type CanvasNodeCategory, type CanvasNodeDefinition } from "@/types/canvas-plugin";
import { CanvasPanel, useCanvasPanel, type CanvasPanelController } from "./canvas-panel";
import { useCanvasPopoverAnchor } from "./use-canvas-popover-anchor";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

export function ConnectionCreateMenu({
    pending,
    scale = 1,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    scale?: number;
    onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div
            className="absolute z-[120] w-[240px] rounded-2xl border p-2 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, transform: `scale(${1 / scale})`, transformOrigin: "top left", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-canvas-ui font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.fromNode")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    ×
                </button>
            </div>
            <div className="grid gap-0.5">
                <ConnectionCreateOption theme={theme} icon={<List className="size-4" />} title={t("canvas.createMenu.text")} description={t("canvas.createMenu.textDescription")} onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-4" />} title={t("canvas.createMenu.image")} onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-4" />} title={t("canvas.createMenu.video")} onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-4" />} title={t("canvas.createMenu.audio")} onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-4" />} title={t("canvas.createMenu.config")} description={t("canvas.createMenu.configDescription")} onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

export function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-canvas-ui font-medium leading-5">{title}</span>
                {description ? (
                    <span className="mt-0.5 block truncate text-canvas-caption" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

const categoryOf = (definition: CanvasNodeDefinition): CanvasNodeCategory => CANVAS_NODE_CATEGORIES.find((category) => category === definition.category) || "extensions";

function navigateNodeMenu(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next].focus();
}

function NodeCreateItem({ definition, onCreate }: { definition: CanvasNodeDefinition; onCreate: (type: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const title = getNodeSpec(definition.type).title;
    return <button type="button" role="menuitem" title={[title, definition.description].filter(Boolean).join("\n")} onClick={() => onCreate(definition.type)} className="flex h-12 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left transition hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline focus-visible:outline-1">
        <span className="grid size-5 shrink-0 place-items-center" style={{ color: theme.node.muted }}>{definition.icon}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-canvas-ui">{title}</span>{definition.description ? <span className="mt-0.5 block truncate text-canvas-caption" style={{ color: theme.node.faint }}>{definition.description}</span> : null}</span>
    </button>;
}

type ActiveNodeCategory = { category: CanvasNodeCategory; button: HTMLButtonElement; focusFirst: boolean };

function NodeCategorySubmenu({ active, definitions, panel, onCreate, onBack }: { active: ActiveNodeCategory; definitions: CanvasNodeDefinition[]; panel: CanvasPanelController; onCreate: (type: string) => void; onBack: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const rowRef = useMemo(() => ({ current: active.button }), [active.button]);
    const anchor = useCanvasPopoverAnchor(rowRef, true);
    const submenuRef = useRef<HTMLDivElement>(null);
    const positioned = anchor !== null;
    useLayoutEffect(() => {
        if (active.focusFirst && positioned) submenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }, [active, positioned]);
    if (!anchor) return null;
    const width = 300, height = definitions.length * 48 + 50, margin = 12;
    const left = anchor.right + 4 + width <= window.innerWidth - margin ? anchor.right + 4 : anchor.left - 4 - width;
    return createPortal(<CanvasPanel panel={panel} panelRef={submenuRef} id={`canvas-node-category-${active.category}`} role="menu" aria-label={t(`canvas.createMenu.categories.${active.category}`)} data-canvas-no-zoom className="fixed z-[121] flex cursor-default flex-col overflow-hidden rounded-lg border shadow-2xl [&_button]:cursor-pointer" style={{ width, maxWidth: `calc(100vw - ${margin * 2}px)`, maxHeight: `calc(100dvh - ${margin * 2}px)`, left: `clamp(${margin}px, ${left}px, max(${margin}px, calc(100vw - ${width + margin}px)))`, top: `clamp(${margin}px, ${anchor.top}px, max(${margin}px, calc(100dvh - ${height + margin}px)))`, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); onBack(); } else navigateNodeMenu(event); }}>
        <div className="flex h-10 shrink-0 items-center border-b px-3 text-canvas-caption" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>{t(`canvas.createMenu.categories.${active.category}`)}</div>
        <div className="thin-scrollbar min-h-0 overflow-x-hidden overflow-y-auto p-1">{definitions.map((def) => <NodeCreateItem key={def.type} definition={def} onCreate={onCreate} />)}</div>
    </CanvasPanel>, document.body);
}

export function NodeCreateMenu({ position, onCreate, onClose }: { position: Position; onCreate: (type: string) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    useNodeRegistryVersion();
    const anchorRef = useRef<HTMLSpanElement>(null);
    const panel = useCanvasPanel({ onDismiss: onClose, closeOnEscape: true });
    const anchor = useCanvasPopoverAnchor(anchorRef, true);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState<ActiveNodeCategory | null>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const definitions = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = definitions.filter((def) => {
        const text = `${getNodeSpec(def.type).title} ${def.description || ""} ${def.type} ${t(`canvas.createMenu.categories.${categoryOf(def)}`)}`.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
    });
    const categories = CANVAS_NODE_CATEGORIES.filter((category) => definitions.some((def) => categoryOf(def) === category));
    const searching = terms.length > 0;
    useLayoutEffect(() => { panel.show(); }, [panel.show]);
    const width = 260, height = searching ? Math.min(520, matching.length ? matching.length * 48 + 100 : 184) : categories.length * 36 + 100, margin = 12;
    return (
        <>
            <span ref={anchorRef} className="pointer-events-none absolute" style={{ left: position.x, top: position.y }} />
            {anchor ? createPortal(
                <CanvasPanel panel={panel} role="dialog" aria-label={t("canvas.createMenu.select")} data-canvas-no-zoom className="fixed z-[120] flex cursor-default flex-col overflow-hidden rounded-lg border shadow-2xl [&_button:not(:disabled)]:cursor-pointer [&_input]:cursor-text" style={{ width, maxWidth: `calc(100vw - ${margin * 2}px)`, maxHeight: `min(520px, calc(100dvh - ${margin * 2}px))`, left: `clamp(${margin}px, ${anchor.left}px, max(${margin}px, calc(100vw - ${width + margin}px)))`, top: `clamp(${margin}px, ${anchor.top}px, max(${margin}px, calc(100dvh - ${height + margin}px)))`, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                    <div className="shrink-0 space-y-1 border-b px-2 py-1.5" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="px-1 text-canvas-title font-semibold" style={{ color: theme.node.muted }}>{t("canvas.createMenu.select")}</h2>
                            <button type="button" className="grid size-7 shrink-0 place-items-center rounded-lg opacity-55 transition hover:opacity-100" onClick={panel.close} aria-label={t("canvas.createMenu.close")}><X className="size-4" /></button>
                        </div>
                        <div className="flex min-w-0 items-center gap-2 rounded-lg border px-3 focus-within:ring-1" style={{ borderColor: theme.node.stroke }}>
                            <Search className="size-4 shrink-0" style={{ color: theme.node.faint }} />
                            <input autoFocus type="search" aria-label={t("canvas.createMenu.search")} placeholder={t("canvas.createMenu.search")} value={query} onChange={(event) => { setQuery(event.target.value); setActive(null); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && searching && matching[0]) { event.preventDefault(); onCreate(matching[0].type); } else if (event.key === "ArrowDown") { event.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); } }} className="h-8 min-w-0 flex-1 bg-transparent text-canvas-ui outline-none [&::-webkit-search-cancel-button]:appearance-none" />
                            {query ? <button type="button" aria-label={t("canvas.createMenu.clearSearch")} onClick={() => setQuery("")} className="grid size-6 shrink-0 place-items-center opacity-55 hover:opacity-100"><X className="size-3.5" /></button> : null}
                        </div>
                    </div>
                    <div ref={resultsRef} role="menu" aria-label={t("canvas.createMenu.category")} onKeyDown={navigateNodeMenu} className="thin-scrollbar min-h-0 overflow-x-hidden overflow-y-auto p-1">
                        {searching ? matching.length ? matching.map((def) => <NodeCreateItem key={def.type} definition={def} onCreate={onCreate} />) : <div role="status" className="px-3 py-6 text-center text-canvas-ui" style={{ color: theme.node.muted }}>{t("canvas.createMenu.noResults")}</div> : categories.map((category) => <button key={category} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={active?.category === category} aria-controls={active?.category === category ? `canvas-node-category-${category}` : undefined} onMouseEnter={(event) => setActive({ category, button: event.currentTarget, focusFirst: false })} onFocus={(event) => setActive({ category, button: event.currentTarget, focusFirst: false })} onClick={(event) => setActive({ category, button: event.currentTarget, focusFirst: event.detail === 0 })} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setActive({ category, button: event.currentTarget, focusFirst: true }); } }} className="flex h-9 w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-canvas-ui hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline focus-visible:outline-1" style={{ background: active?.category === category ? theme.toolbar.activeBg : undefined }}>
                            <span className="min-w-0 flex-1 truncate">{t(`canvas.createMenu.categories.${category}`)}</span><span className="text-canvas-caption" style={{ color: theme.node.faint }}>{definitions.filter((def) => categoryOf(def) === category).length}</span><ChevronRight className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                        </button>)}
                    </div>
                </CanvasPanel>, document.body,
            ) : null}
            {active && !searching ? <NodeCategorySubmenu key={active.category} active={active} definitions={definitions.filter((def) => categoryOf(def) === active.category)} panel={panel} onCreate={onCreate} onBack={() => { active.button.focus(); setActive(null); }} /> : null}
        </>
    );
}
