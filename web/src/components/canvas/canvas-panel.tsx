import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject, type SetStateAction } from "react";

// Third-party dropdown portals do not participate in our React panel context.
const attachedPopupSelector = ".ant-select-dropdown,.ant-dropdown,.ant-popover,.ant-picker-dropdown,[data-canvas-resource-mention-menu]";
const PanelAncestors = createContext<Set<HTMLElement>[]>([]);
type ActivationEvent = { detail: number };

/** Shared state and interaction for node panels and standalone popovers. */
export function useCanvasPanel({ onOpenChange, onDismiss, closeOnEscape = false }: {
    onOpenChange?: (open: boolean) => void;
    onDismiss?: () => void;
    closeOnEscape?: boolean;
} = {}) {
    const [activeId, updateActiveId] = useState<string | null>(null);
    const elements = useRef(new Set<HTMLElement>()).current;
    const dismissedId = useRef<string | null>(null);
    const current = useRef({ activeId, onOpenChange, onDismiss, closeOnEscape });
    useLayoutEffect(() => { current.current = { activeId, onOpenChange, onDismiss, closeOnEscape }; });

    const setActiveId = useCallback((value: SetStateAction<string | null>) => {
        const next = typeof value === "function" ? value(current.current.activeId) : value;
        if (current.current.activeId === next) return;
        const wasOpen = current.current.activeId !== null;
        current.current.activeId = next;
        updateActiveId(next);
        if (wasOpen !== (next !== null)) current.current.onOpenChange?.(next !== null);
    }, []);
    const close = useCallback(() => {
        if (current.current.activeId === null) return;
        current.current.onDismiss?.();
        setActiveId(null);
    }, [setActiveId]);
    const show = useCallback((id = "panel", event?: ActivationEvent) => {
        if (event?.detail !== 0 && dismissedId.current === id) return false;
        setActiveId(id);
        return true;
    }, [setActiveId]);
    const toggle = useCallback((id = "panel", event?: ActivationEvent) => {
        if (event?.detail !== 0 && dismissedId.current === id) return false;
        if (current.current.activeId === id) close();
        else setActiveId(id);
        return true;
    }, [setActiveId, close]);

    useEffect(() => {
        const pointerDown = (event: PointerEvent) => {
            dismissedId.current = null;
            if (current.current.activeId === null) return;
            const target = event.target;
            if (target instanceof Node && [...elements].some((element) => element.contains(target))) return;
            const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
            if (element?.closest(attachedPopupSelector)) return;
            // Retain the closed identity through pointerup/click, even after React rerenders.
            dismissedId.current = current.current.activeId;
            close();
        };
        const keyDown = (event: KeyboardEvent) => {
            dismissedId.current = null;
            if (event.key === "Escape" && current.current.closeOnEscape) close();
        };
        window.addEventListener("pointerdown", pointerDown, true);
        window.addEventListener("keydown", keyDown, true);
        return () => {
            window.removeEventListener("pointerdown", pointerDown, true);
            window.removeEventListener("keydown", keyDown, true);
        };
    }, [close, elements]);

    return useMemo(() => ({ activeId, setActiveId, isOpen: activeId !== null, show, toggle, close, elements }), [activeId, setActiveId, show, toggle, close, elements]);
}

export type CanvasPanelController = ReturnType<typeof useCanvasPanel>;

/** Registers content with its own panel and its ancestors, including through portals. */
export function CanvasPanel({ panel, panelRef, children, ...props }: HTMLAttributes<HTMLDivElement> & {
    panel: CanvasPanelController;
    panelRef?: RefObject<HTMLDivElement | null>;
}) {
    const ancestors = useContext(PanelAncestors);
    const owners = useMemo(() => [...ancestors, panel.elements], [ancestors, panel.elements]);
    const register = useCallback((element: HTMLDivElement | null) => {
        if (!element) return;
        if (panelRef) panelRef.current = element;
        owners.forEach((owner) => owner.add(element));
        return () => {
            owners.forEach((owner) => owner.delete(element));
            if (panelRef?.current === element) panelRef.current = null;
        };
    }, [owners, panelRef]);

    return <PanelAncestors.Provider value={owners}>
        <div {...props} ref={register} data-canvas-panel="" onPointerDown={(event) => { props.onPointerDown?.(event); event.stopPropagation(); }} onMouseDown={(event) => { props.onMouseDown?.(event); event.stopPropagation(); }} onClick={(event) => { props.onClick?.(event); event.stopPropagation(); }}>
            {children}
        </div>
    </PanelAncestors.Provider>;
}
