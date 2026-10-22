const activeReads = new Map<string, Promise<void>>();

export function beginKritaRead(projectId: string, nodeId: string) {
    const key = `${projectId}:${nodeId}`;
    if (activeReads.has(key)) return null;
    let finish!: () => void;
    activeReads.set(key, new Promise<void>((resolve) => { finish = resolve; }));
    return () => { activeReads.delete(key); finish(); };
}

export function waitForKritaRead(projectId: string, nodeId: string, signal: AbortSignal) {
    const current = activeReads.get(`${projectId}:${nodeId}`);
    if (!current || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
        current.then(finish);
        signal.addEventListener("abort", finish, { once: true });
    });
}
