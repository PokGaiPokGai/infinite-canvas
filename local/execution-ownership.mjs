// Ownership lasts for the live HTTP connection. No expiry or silent takeover of a running task.
export function createExecutionOwnership(revision) {
    const owners = new Map();
    function handle(request, response) {
        const url = new URL(request.url, 'http://127.0.0.1');
        const project = url.searchParams.get('project'), node = url.searchParams.get('node');
        const fail = (status, error) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error })); };
        if (request.method !== 'POST' || !project || !node) return fail(400, '执行所有权请求无效。');
        const key = JSON.stringify([project, node]);
        if (owners.has(key)) return fail(409, '此节点正在另一个窗口执行，请等待完成后重新载入。');
        if (request.headers['if-match'] !== String(revision())) return fail(409, '共享数据已经变化，请重新载入后再执行，避免重复生成。');
        owners.set(key, response);
        response.once('close', () => { if (owners.get(key) === response) owners.delete(key); });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write(': owned\n\n');
    }
    return { handle, get active() { return owners.size; }, close() { for (const response of owners.values()) response.end(); owners.clear(); } };
}
