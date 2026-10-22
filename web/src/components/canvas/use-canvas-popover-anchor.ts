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
    useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

    useEffect(() => {
        if (!open) return;
        let outsideStart: { pointerId: number; x: number; y: number } | null = null;
        const isInside = (target: EventTarget | null) => {
            if (!(target instanceof Node)) return false;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return true;
            const element = target instanceof Element ? target : target.parentElement;
            return !!element?.closest(".ant-select-dropdown,.ant-dropdown,.ant-popover,.ant-picker-dropdown,[data-canvas-resource-mention-menu]");
        };
        const onPointerDown = (event: PointerEvent) => {
            if (event.button !== 0 || !event.isPrimary || isInside(event.target)) {
                outsideStart = null;
                return;
            }
            outsideStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        };
        const onPointerUp = (event: PointerEvent) => {
            if (!outsideStart || outsideStart.pointerId !== event.pointerId) return;
            const { x, y } = outsideStart;
            outsideStart = null;
            if (event.button === 0 && event.isPrimary && !isInside(event.target) && Math.hypot(event.clientX - x, event.clientY - y) <= 3) closeRef.current();
        };
        const onPointerCancel = () => { outsideStart = null; };
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("pointercancel", onPointerCancel, true);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("pointerup", onPointerUp, true);
            window.removeEventListener("pointercancel", onPointerCancel, true);
        };
    }, [buttonRef, panelRef, open]);
}
