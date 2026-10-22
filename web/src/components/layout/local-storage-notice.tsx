import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { exportPendingSharedWrites, flushSharedWrites, getSharedStorageStatus, isSharedStorageEnabled, subscribeSharedStorage } from "@/lib/shared-storage";

function isEditingInput() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select"))) return true;
    return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
        .some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== "hidden");
}

export function LocalStorageNotice() {
    const status = useSyncExternalStore(subscribeSharedStorage, getSharedStorageStatus);
    const { pathname } = useLocation();
    const [actionError, setActionError] = useState("");
    const [reloading, setReloading] = useState(false);
    const enabled = isSharedStorageEnabled();
    const error = status.error || actionError;

    useEffect(() => {
        if (!enabled || !status.remoteChanged || status.pending || error || pathname !== "/canvas" || isEditingInput()) return;
        let active = true;
        void flushSharedWrites().then(() => {
            const current = getSharedStorageStatus();
            if (active && !current.pending && !current.error && location.pathname === "/canvas" && !isEditingInput()) location.reload();
        }).catch((reason: unknown) => {
            if (active) setActionError(reason instanceof Error ? reason.message : "尚有内容未保存，请先导出副本。");
        });
        return () => { active = false; };
    }, [enabled, error, pathname, status.pending, status.remoteChanged]);

    if (!enabled) return null;

    const reload = async () => {
        setReloading(true);
        setActionError("");
        try {
            await flushSharedWrites();
            if (getSharedStorageStatus().pending || getSharedStorageStatus().error) throw new Error("尚有内容未保存，请先导出未保存内容。");
            location.reload();
        } catch (reason) {
            setActionError(reason instanceof Error ? reason.message : "保存失败，请先导出未保存内容。");
            setReloading(false);
        }
    };

    const exportPending = async () => {
        try {
            await exportPendingSharedWrites();
        } catch (reason) {
            setActionError(reason instanceof Error ? reason.message : "未保存内容导出失败。");
        }
    };

    const text = error
        ? `保存未完成：${error}`
        : status.pending
          ? `正在保存到本机（${status.pending}）`
          : status.remoteChanged
            ? "另一窗口已更新本机数据，请重新载入后继续编辑。"
            : "已保存到本机";

    return (
        <div className="flex min-h-7 shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-1 text-[11px] text-foreground" role={error ? "alert" : "status"} aria-live="polite">
            <span>{text}</span>
            {status.importConflicts ? <span>迁移发现 {status.importConflicts} 项不同内容，原副本已保留。</span> : null}
            {error || status.remoteChanged ? (
                <button className="shrink-0 underline underline-offset-2 disabled:opacity-50" disabled={reloading} onClick={() => void reload()}>
                    {reloading ? "正在保存…" : "重新载入"}
                </button>
            ) : null}
            {error ? (
                <button className="shrink-0 underline underline-offset-2" onClick={() => void exportPending()}>导出未保存内容</button>
            ) : null}
        </div>
    );
}
