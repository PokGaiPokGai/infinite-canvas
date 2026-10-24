import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createExecutionOwnership } from './execution-ownership.mjs';
import { createSharedStorage } from './shared-storage.mjs';
import { withTestDirectory } from './test-fixture.mjs';

function response() {
    const result = new EventEmitter();
    result.writeHead = status => { result.status = status; };
    result.write = bytes => { result.body = bytes; };
    result.end = bytes => { if (bytes) result.body = JSON.parse(bytes); result.emit('close'); };
    return result;
}
test('only one window owns a node, distinct nodes can run, disconnect releases ownership', () => {
    let revision = 12;
    const execution = createExecutionOwnership(() => revision);
    const take = (node = 'batch', expected = revision) => {
        const result = response();
        execution.handle({ url: `/storage/execution?project=canvas&node=${node}`, method: 'POST', headers: { 'if-match': String(expected) } }, result);
        return result;
    };
    const first = take(); assert.equal(first.status, 200);
    assert.equal(take().status, 409);
    assert.equal(take('workflow').status, 200);
    assert.equal(execution.active, 2);
    first.emit('close'); revision++;
    assert.equal(take('batch', 12).status, 409);
    assert.equal(take().status, 200);
    execution.close(); assert.equal(execution.active, 0);
});

test('shared storage protects execution ownership with the same origin and header checks', () => withTestDirectory(async directory => {
    const storage = createSharedStorage({ dataDirectory: directory });
    const call = async headers => {
        const request = Readable.from([]);
        Object.assign(request, { method: 'POST', url: '/storage/execution?project=canvas&node=batch', headers });
        const result = response();
        await storage.handle(request, result, '/storage/execution');
        return result;
    };
    try {
        assert.equal((await call({ origin: 'https://outside.invalid', 'x-infinite-canvas-storage': '1' })).status, 403);
        assert.equal((await call({ origin: 'http://127.0.0.1:3000' })).status, 403);
        const headers = { origin: 'http://127.0.0.1:3000', 'x-infinite-canvas-storage': '1', 'if-match': '0' };
        const owned = await call(headers); assert.equal(owned.status, 200);
        assert.equal(storage.activeExecutions, 1);
        assert.equal((await call(headers)).status, 409);
        owned.emit('close'); assert.equal(storage.activeExecutions, 0);
    } finally { storage.close(); }
}));

test('real HTTP stream retains ownership until its window disconnects', async () => {
    const execution = createExecutionOwnership(() => 0);
    let ownerResponse;
    const server = createServer((request, response) => { execution.handle(request, response); if (response.statusCode === 200) ownerResponse = response; });
    const controller = new AbortController();
    try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const url = `http://127.0.0.1:${server.address().port}/storage/execution?project=canvas&node=batch`;
        const first = await fetch(url, { method: 'POST', headers: { 'If-Match': '0' }, signal: controller.signal });
        assert.equal(first.status, 200);
        const conflict = await fetch(url, { method: 'POST', headers: { 'If-Match': '0' } });
        assert.equal(conflict.status, 409); await conflict.json();
        const closed = once(ownerResponse, 'close'); controller.abort(); await closed;
        assert.equal(execution.active, 0);
    } finally {
        controller.abort(); execution.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
