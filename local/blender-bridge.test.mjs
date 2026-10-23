import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createBlenderBridge } from './blender-bridge.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const extract = code => JSON.parse(Buffer.from(code.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)[1], 'base64').toString('utf8'));
const result = value => ({ executed: true, result: 'log line\n__IC_BLENDER__' + JSON.stringify(value) + '\n' });
async function call(bridge, path, body, headers = {}) {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    request.method = body === undefined ? 'GET' : 'POST';
    request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', 'x-infinite-canvas-blender-ui': '1', ...headers };
    let status, value;
    const response = { writeHead(code) { status = code; }, end(bytes) { value = JSON.parse(bytes); } };
    assert.equal(await bridge.handle(request, response, path), true);
    return { status, value };
}
async function fixture(action) {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-blender-test-'));
    try { await action(appRoot); } finally {
        assert.equal(dirname(resolve(appRoot)), resolve(tmpdir()));
        assert.match(basename(appRoot), /^infinite-canvas-blender-test-/);
        await rm(appRoot, { recursive: true, force: true });
    }
}

test('only fixed operations reach Blender; cross-origin, missing headers and invalid bindings are rejected', async () => fixture(async appRoot => {
    let calls = 0;
    const bridge = createBlenderBridge({ appRoot, commandImpl: async (type, { code }) => {
        calls++; assert.equal(type, 'execute_code'); assert.deepEqual(extract(code), { operation: 'status' });
        return result({ connected: true, sources: [], targets: [], images: [] });
    } });
    assert.equal((await call(bridge, '/blender/status', undefined, { origin: 'https://example.com' })).status, 403);
    assert.equal((await call(bridge, '/blender/status', undefined, { 'x-infinite-canvas-blender-ui': undefined })).status, 403);
    assert.equal((await call(bridge, '/blender/status', undefined, { host: 'example.com' })).status, 403);
    assert.equal((await call(bridge, '/blender/snapshots', { sessionId: '../file', sourceId: randomUUID(), code: 'malicious()' })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await call(bridge, '/blender/status')).status, 200);
    assert.equal(calls, 1);
}));

test('a separate preview accepts only its configured origin', async () => fixture(async appRoot => {
    const bridge = createBlenderBridge({ appRoot, canvasOrigin: 'http://127.0.0.1:3030', commandImpl: async () => result({ connected: true, sources: [], targets: [], images: [] }) });
    assert.equal((await call(bridge, '/blender/status')).status, 403);
    assert.equal((await call(bridge, '/blender/status', undefined, { host: '127.0.0.1:3030', origin: 'http://127.0.0.1:3030' })).status, 200);
    assert.equal((await call(bridge, '/blender/status', undefined, { host: '127.0.0.1:3030', origin: 'https://example.com' })).status, 403);
}));

test('snapshot bytes, hash and dimensions are verified before storage', async () => fixture(async appRoot => {
    const sessionId = randomUUID(), sourceId = randomUUID();
    let corrupt = false;
    const bridge = createBlenderBridge({ appRoot, commandImpl: async (_type, { code }) => {
        assert.deepEqual(extract(code), { operation: 'snapshot', sessionId, sourceId });
        return result({ sessionId, sourceId, sourceName: 'Test viewport', width: 1, height: 1, sha256: corrupt ? '0'.repeat(64) : sha256(png), imageBase64: png.toString('base64') });
    } });
    const response = await call(bridge, '/blender/snapshots', { sessionId, sourceId, code: 'ignored()' });
    assert.equal(response.status, 201);
    assert.deepEqual(await readFile(join(appRoot, '.local/blender-link/snapshots', `${response.value.id}.png`)), png);
    assert.equal(response.value.imageBase64, undefined);
    corrupt = true;
    assert.equal((await call(bridge, '/blender/snapshots', { sessionId, sourceId })).status, 502);
}));

test('write receipts survive a new bridge instance and changed targets or pixels cannot reuse the command', async () => fixture(async appRoot => {
    const payload = { sessionId: randomUUID(), commandId: randomUUID(), destination: { kind: 'node', targetId: randomUUID(), expectedImageId: null }, colorSpace: 'sRGB', imageBase64: png.toString('base64') };
    let applies = 0;
    const commandImpl = async (_type, { code }) => {
        const data = extract(code); applies++;
        assert.equal(data.operation, 'write'); assert.equal(data.sha256, sha256(png)); assert.equal(data.width, 1);
        return result({ commandId: data.commandId, sessionId: data.sessionId, destination: data.destination, imageId: randomUUID(), imageName: 'Canvas Result', sha256: data.sha256 });
    };
    const bridge = createBlenderBridge({ appRoot, commandImpl });
    const first = await call(bridge, '/blender/returns', payload);
    assert.equal(first.status, 200);
    const restarted = createBlenderBridge({ appRoot, commandImpl });
    assert.deepEqual(await call(restarted, '/blender/returns', payload), first);
    assert.equal(applies, 1);
    assert.equal((await call(bridge, '/blender/returns', { ...payload, destination: { ...payload.destination, targetId: randomUUID() } })).status, 409);
    const other = Buffer.from(png); other[other.length - 1] ^= 1;
    assert.equal((await call(bridge, '/blender/returns', { ...payload, imageBase64: other.toString('base64') })).status, 409);
    assert.equal(applies, 1);
}));

test('lost response retries the identical native command and a changed Blender session is rejected', async () => fixture(async appRoot => {
    const payload = { sessionId: randomUUID(), commandId: randomUUID(), destination: { kind: 'image', imageId: randomUUID(), expectedRevision: 'a'.repeat(64) }, colorSpace: 'Non-Color', imageBase64: png.toString('base64') };
    const calls = [];
    const bridge = createBlenderBridge({ appRoot, commandImpl: async (_type, { code }) => {
        calls.push(extract(code));
        if (calls.length === 1) throw new Error('response lost');
        assert.deepEqual(calls[0], calls[1]);
        return result({ error: 'session changed', status: 409 });
    } });
    assert.equal((await call(bridge, '/blender/returns', payload)).status, 500);
    assert.equal((await call(bridge, '/blender/returns', payload)).status, 409);
    assert.equal(calls.length, 2);
    assert.equal((await call(bridge, '/blender/returns', { ...payload, colorSpace: 'sRGB' })).status, 409);
    assert.equal(calls.length, 2);
}));

test('concurrent requests are serialized without replaying failures', async () => fixture(async appRoot => {
    let inFlight = 0, maxInFlight = 0;
    const bridge = createBlenderBridge({ appRoot, commandImpl: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolveWait => setImmediate(resolveWait));
        inFlight--; return result({ connected: true, sources: [], targets: [], images: [] });
    } });
    const responses = await Promise.all([call(bridge, '/blender/status'), call(bridge, '/blender/status')]);
    assert.ok(responses.every(response => response.status === 200)); assert.equal(maxInFlight, 1);
}));

test('image previews validate identity and PNG dimensions without permitting arbitrary operations', async () => fixture(async appRoot => {
    const sessionId = randomUUID(), imageId = randomUUID();
    let wrong = false, calls = 0;
    const bridge = createBlenderBridge({ appRoot, commandImpl: async (_type, { code }) => {
        calls++;
        assert.deepEqual(extract(code), { operation: 'image-preview', sessionId, imageId });
        return result({ sessionId, imageId: wrong ? randomUUID() : imageId, revision: 'a'.repeat(64), width: 1, height: 1, imageBase64: png.toString('base64') });
    } });
    assert.equal((await call(bridge, '/blender/image-preview', { sessionId, imageId, code: 'ignored()' })).status, 200);
    wrong = true;
    assert.equal((await call(bridge, '/blender/image-preview', { sessionId, imageId })).status, 502);
    assert.equal((await call(bridge, '/blender/image-preview', { sessionId, imageId: '../image' })).status, 400);
    assert.equal(calls, 2);
}));

test('direct and new-image writes freeze the destination, reject malformed bindings and verify receipts', async () => fixture(async appRoot => {
    const payload = { sessionId: randomUUID(), commandId: randomUUID(), colorSpace: 'sRGB', imageBase64: png.toString('base64') };
    let calls = 0, wrong = false;
    const bridge = createBlenderBridge({ appRoot, commandImpl: async (_type, { code }) => {
        calls++;
        const data = extract(code);
        return result({ commandId: data.commandId, sessionId: data.sessionId, destination: wrong ? { kind: 'new', name: 'different' } : data.destination, imageId: randomUUID(), imageName: 'Result', sha256: data.sha256 });
    } });
    for (const destination of [{ kind: 'image', imageId: randomUUID() }, { kind: 'new', name: ' ' }, { kind: 'node', targetId: randomUUID() }, { kind: 'file', path: 'private' }]) {
        assert.equal((await call(bridge, '/blender/returns', { ...payload, destination })).status, 400);
    }
    assert.equal(calls, 0);
    const direct = { ...payload, destination: { kind: 'image', imageId: randomUUID(), expectedRevision: 'a'.repeat(64) } };
    const first = await call(bridge, '/blender/returns', direct);
    assert.equal(first.status, 200);
    assert.deepEqual(await call(bridge, '/blender/returns', direct), first);
    assert.equal(calls, 1);
    assert.equal((await call(bridge, '/blender/returns', { ...direct, destination: { ...direct.destination, expectedRevision: 'b'.repeat(64) } })).status, 409);
    const create = { ...payload, commandId: randomUUID(), destination: { kind: 'new', name: 'Canvas Result' } };
    const created = await call(bridge, '/blender/returns', create);
    assert.equal(created.status, 200);
    assert.deepEqual(await call(bridge, '/blender/returns', create), created);
    assert.equal(calls, 2);
    assert.equal((await call(bridge, '/blender/returns', { ...create, destination: { kind: 'new', name: 'changed' } })).status, 409);
    wrong = true;
    assert.equal((await call(bridge, '/blender/returns', { ...create, commandId: randomUUID() })).status, 502);
}));
