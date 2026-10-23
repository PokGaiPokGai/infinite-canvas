import { useLayoutEffect, useState, type RefObject } from "react";

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
