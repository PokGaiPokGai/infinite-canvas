import { flushSharedWrites, getSharedStorageRevision, getSharedStorageStatus, isSharedStorageEnabled } from '../shared-storage';

export async function withProcessingOwnership<T>(project: string, node: string, controller: AbortController, work: () => Promise<T>): Promise<T> {
    if (!isSharedStorageEnabled()) {
        if (!navigator.locks) throw new Error('当前浏览器不支持跨窗口任务锁，请使用支持 Web Locks 的浏览器。');
        return navigator.locks.request(`canvas-execution:${project}:${node}`, { ifAvailable: true }, async lock => {
            if (!lock) throw new Error('此节点正在另一个窗口执行，请等待完成后重新载入。');
            controller.signal.throwIfAborted();
            return work();
        });
    }
    await flushSharedWrites();
    const status = getSharedStorageStatus();
    if (status.remoteChanged || status.error) throw new Error(status.error || '共享数据已经变化，请重新载入后再执行。');
    const connection = new AbortController();
    const abort = () => connection.abort();
    controller.signal.throwIfAborted();
    controller.signal.addEventListener('abort', abort, { once: true });
    let released = false;
    try {
        const response = await fetch(`/local-data/execution?${new URLSearchParams({ project, node })}`, {
            method: 'POST', signal: connection.signal,
            headers: { 'X-Infinite-Canvas-Storage': '1', 'If-Match': String(getSharedStorageRevision()) },
        });
        if (!response.ok) throw new Error((await response.json()).error || '后台不支持执行所有权，请更新本机服务。');
        // Cancellation asks the work to stop. Keep ownership until its result and writes have settled.
        controller.signal.removeEventListener('abort', abort);
        controller.signal.throwIfAborted();
        const reader = response.body!.getReader();
        const monitor = async () => { try { while (!(await reader.read()).done) { /* Keep ownership until release. */ } } catch { /* Abort or disconnected backend. */ } finally { if (!released) controller.abort(new Error('执行连接中断，已停止本页等待；已提交的生成可能仍在后台完成，请核对后再重试。')); } };
        const watching = monitor();
        try { return await work(); }
        finally { released = true; connection.abort(); await watching; }
    } finally { released = true; connection.abort(); controller.signal.removeEventListener('abort', abort); }
}
