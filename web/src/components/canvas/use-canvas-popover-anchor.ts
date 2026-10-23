import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useCanvasPopoverAnchor(buttonRef: RefObject<HTMLElement | null>, open: boolean) {
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useLayoutEffect(() => {
        if (!open) return;
        let lastRect: DOMRect | null = null;
        const syncPosition = () => {
            const next = buttonRef.current?.getBoundingClientRect() || null;
            if (next && lastRect && next.x === lastRect.x && next.y === lastRect.y && next.width === lastRect.width && next.height === lastRect.height) return;
            if (!next && !lastRect) return;
            lastRect = next;
            setButtonRect(next);
        };

        syncPosition();
        const transformObserver = new MutationObserver(syncPosition);
        for (let element = buttonRef.current?.parentElement; element; element = element.parentElement) {
            transformObserver.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
        }
        const sizeObserver = new ResizeObserver(syncPosition);
        if (buttonRef.current) sizeObserver.observe(buttonRef.current);
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        return () => {
            transformObserver.disconnect();
            sizeObserver.disconnect();
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
        };
    }, [buttonRef, open]);

    return buttonRect;
}

export function useCanvasPopoverOutsideClick(buttonRef: RefObject<HTMLElement | null>, panelRef: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
    const closeRef = useRef(onClose);
    const closedByTriggerRef = useRef(false);
    useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

    useEffect(() => {
        const isInside = (target: EventTarget | null) => {
            if (!(target instanceof Node)) return false;
            if (panelRef.current?.contains(target)) return true;
            const element = target instanceof Element ? target : target.parentElement;
            return !!element?.closest(".ant-select-dropdown,.ant-dropdown,.ant-popover,.ant-picker-dropdown,[data-canvas-resource-mention-menu]");
        };
        const onPointerDown = (event: PointerEvent) => {
            closedByTriggerRef.current = false;
            if (!open || isInside(event.target)) return;
            closedByTriggerRef.current = event.target instanceof Node && !!buttonRef.current?.contains(event.target);
            closeRef.current();
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
        };
    }, [buttonRef, panelRef, open]);

    // A trigger press closes on pointerdown; its later click must not reopen the panel.
    return (event: { detail: number }) => event.detail > 0 && closedByTriggerRef.current;
}
