import test from 'node:test';
import assert from 'node:assert/strict';
process.env.CANVAS_TEST_SHARED_STORAGE = '1';
const { withProcessingOwnership } = await import('../src/lib/canvas/processing-ownership');

test('cancel keeps shared ownership until work settles; release closes the connection', async () => {
    const originalFetch = globalThis.fetch;
    let connection: AbortSignal | undefined;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = async (_url, options) => {
        connection = options?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
        connection.addEventListener('abort', () => stream.close(), { once: true });
        return new Response(body);
    };
    try {
        const controller = new AbortController();
        const run = withProcessingOwnership('fixture', 'batch', controller, () => new Promise(resolve => { release = () => resolve('done'); started(); }));
        await ready;
        controller.abort();
        assert.equal(connection?.aborted, false);
        release();
        assert.equal(await run, 'done');
        assert.equal(connection?.aborted, true);
    } finally { globalThis.fetch = originalFetch; }
});

test('lost backend ownership cancels work and rejects without silently taking another lock', async () => {
    const originalFetch = globalThis.fetch;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    try {
        const controller = new AbortController();
        const run = withProcessingOwnership('fixture', 'workflow', controller, async () => {
            const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
            stream.close();
            return cancelled;
        });
        await assert.rejects(run, /执行连接中断/);
        assert.equal(controller.signal.aborted, true);
    } finally { globalThis.fetch = originalFetch; }
});
