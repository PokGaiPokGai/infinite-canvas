import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createKritaBridge } from './krita-bridge.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const projectId = 'A'.repeat(21);
const claimPath = (clientId) => `/krita/auto/claim?projectId=${projectId}&clientId=${clientId}`;
const heartbeatPath = (clientId, leaseId) => `/krita/auto/heartbeat?projectId=${projectId}&clientId=${clientId}&leaseId=${leaseId}`;
const watchPath = (after, clientId) => `/krita/watch?after=${after}&projectId=${projectId}&clientId=${clientId}`;

async function setup(t, fetchImpl) {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-auto-test-'));
    const checked = resolve(appRoot);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.match(basename(checked), /^infinite-canvas-krita-auto-test-/);
    t.after(() => rm(checked, { recursive: true, force: true }));
    const linkRoot = join(appRoot, '.local', 'krita-link');
    await mkdir(linkRoot, { recursive: true });
    await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
    return { bridge: createKritaBridge({ appRoot, fetchImpl }), linkRoot };
}

function requestOf(path, body) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = body === undefined ? 'GET' : 'POST';
    request.url = path;
    request.headers = { 'x-infinite-canvas-krita-ui': '1', ...(body === undefined ? {} : {
        origin: 'http://127.0.0.1:3000', 'content-type': 'application/json',
    }) };
    return request;
}

function responseOf() {
    const response = new EventEmitter();
    response.destroyed = false;
    response.writeHead = (code) => { response.status = code; };
    response.end = (data) => { response.value = JSON.parse(data); };
    return response;
}

async function call(bridge, path, body) {
    const response = responseOf();
    assert.equal(await bridge.handle(requestOf(path, body), response, path.split('?')[0]), true);
    return { status: response.status, value: response.value };
}

async function claim(bridge, clientId, leader) {
    const result = await call(bridge, claimPath(clientId));
    assert.equal(result.status, 200);
    assert.equal(result.value.leader, leader);
    if (leader) assert.match(result.value.leaseId, /^[0-9a-f-]{36}$/i);
    else assert.deepEqual(result.value, { leader: false });
    return result.value;
}

test('unchanged Auto snapshot returns a hash check without saving another PNG', async (t) => {
    const documentId = randomUUID(), layerId = randomUUID(), sessionId = randomUUID();
    const pixelSha256 = sha256(Buffer.from('same pixels'));
    let requested;
    const { bridge, linkRoot } = await setup(t, async (url, options) => {
        assert.match(url, /\/snapshot$/);
        requested = JSON.parse(options.body);
        return Response.json({ unchanged: true, pixelSha256, sessionId, documentId, layerId });
    });
    const result = await call(bridge, '/krita/snapshots', { documentId, layerId, expectedPixelSha256: pixelSha256 });
    assert.deepEqual(requested, { documentId, layerId, expectedPixelSha256: pixelSha256 });
    assert.deepEqual(result, { status: 200, value: { unchanged: true, pixelSha256, sessionId, documentId, layerId } });
    assert.deepEqual(await readdir(join(linkRoot, 'snapshots')), []);
});

test('changed Auto snapshot persists its PNG and exposes the pixel hash', async (t) => {
    const documentId = randomUUID(), snapshotId = randomUUID(), sessionId = randomUUID();
    const pixelSha256 = sha256(Buffer.from('new pixels'));
    const { bridge, linkRoot } = await setup(t, async (url) => {
        assert.match(url, /\/snapshot$/);
        return Response.json({ id: snapshotId, sessionId, documentId, documentName: 'art.kra',
            width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8', colorProfile: 'sRGB-elle-V2-srgbtrc.icc',
            sha256: sha256(png), pixelSha256, createdAt: new Date().toISOString(), imageBase64: png.toString('base64') });
    });
    const result = await call(bridge, '/krita/snapshots', { documentId });
    assert.equal(result.status, 201);
    assert.equal(result.value.pixelSha256, pixelSha256);
    assert.equal(result.value.imageUrl, `/krita-link/snapshots/${snapshotId}/image`);
    assert.deepEqual(await readdir(join(linkRoot, 'snapshots')), [snapshotId]);
});

test('one canvas client claims and renews Auto ownership while another stays standby', async (t) => {
    let nativeCalls = 0;
    const { bridge } = await setup(t, async () => { nativeCalls++; throw new Error('unexpected native request'); });
    const first = randomUUID(), second = randomUUID();
    const original = await claim(bridge, first, true);
    const renewed = await claim(bridge, first, true);
    assert.notEqual(renewed.leaseId, original.leaseId);
    await claim(bridge, second, false);
    assert.deepEqual(await call(bridge, watchPath(0, second)), { status: 200, value: { standby: true } });
    assert.equal(nativeCalls, 0);
});

test('an old Auto lease token cannot release a renewed owner', async (t) => {
    const { bridge } = await setup(t, async () => { throw new Error('unexpected native request'); });
    const first = randomUUID(), second = randomUUID();
    const original = await claim(bridge, first, true);
    const renewed = await claim(bridge, first, true);
    assert.deepEqual(await call(bridge, '/krita/auto/release', { projectId, clientId: first, leaseId: original.leaseId }),
        { status: 200, value: { released: false } });
    await claim(bridge, second, false);
    assert.deepEqual(await call(bridge, '/krita/auto/release', { projectId, clientId: first, leaseId: renewed.leaseId }),
        { status: 200, value: { released: true } });
    await claim(bridge, second, true);
});

test('Auto heartbeat renews only the current token and stops after release', async (t) => {
    let now = 1_000;
    t.mock.method(performance, 'now', () => now);
    const { bridge } = await setup(t, async () => { throw new Error('unexpected native request'); });
    const first = randomUUID(), second = randomUUID();
    const original = await claim(bridge, first, true);
    now += 59_000;
    assert.deepEqual(await call(bridge, heartbeatPath(first, original.leaseId)), { status: 200, value: { leader: true } });
    now += 59_000;
    await claim(bridge, second, false);
    const renewed = await claim(bridge, first, true);
    assert.deepEqual(await call(bridge, heartbeatPath(first, original.leaseId)), { status: 200, value: { leader: false } });
    assert.deepEqual(await call(bridge, heartbeatPath(first, renewed.leaseId)), { status: 200, value: { leader: true } });
    assert.deepEqual(await call(bridge, '/krita/auto/release', { projectId, clientId: first, leaseId: renewed.leaseId }),
        { status: 200, value: { released: true } });
    assert.deepEqual(await call(bridge, heartbeatPath(first, renewed.leaseId)), { status: 200, value: { leader: false } });
    await claim(bridge, second, true);
});

test('an expired Auto lease cannot be revived by a late heartbeat', async (t) => {
    let now = 1_000;
    t.mock.method(performance, 'now', () => now);
    const { bridge } = await setup(t, async () => { throw new Error('unexpected native request'); });
    const first = randomUUID(), second = randomUUID();
    const owner = await claim(bridge, first, true);
    now += 60_001;
    assert.deepEqual(await call(bridge, heartbeatPath(first, owner.leaseId)), { status: 200, value: { leader: false } });
    await claim(bridge, second, true);
    assert.deepEqual(await call(bridge, heartbeatPath(first, owner.leaseId)), { status: 200, value: { leader: false } });
});

test('Auto claim and release reject invalid identities without contacting Krita', async (t) => {
    let nativeCalls = 0;
    const { bridge } = await setup(t, async () => { nativeCalls++; throw new Error('unexpected native request'); });
    const clientId = randomUUID();
    for (const path of ['/krita/auto/claim', `/krita/auto/claim?projectId=%2F&clientId=${clientId}`,
        `/krita/auto/claim?projectId=${projectId}&clientId=invalid`,
        `${claimPath(clientId)}&clientId=${randomUUID()}`]) {
        assert.equal((await call(bridge, path)).status, 400, path);
    }
    assert.equal((await call(bridge, '/krita/auto/release', { projectId, clientId, leaseId: 'invalid' })).status, 400);
    assert.equal(nativeCalls, 0);
});

test('only a claimed Auto client can forward a watch to Krita', async (t) => {
    const sessionId = randomUUID(), first = randomUUID(), second = randomUUID();
    let nativeCalls = 0;
    const { bridge } = await setup(t, async (url) => {
        nativeCalls++;
        assert.match(url, /\/watch\?after=0$/);
        return Response.json({ sessionId, revision: 0, changed: false });
    });
    assert.deepEqual(await call(bridge, watchPath(0, first)), { status: 200, value: { standby: true } });
    assert.equal(nativeCalls, 0);
    await claim(bridge, first, true);
    await claim(bridge, second, false);
    assert.deepEqual(await call(bridge, watchPath(0, second)), { status: 200, value: { standby: true } });
    assert.equal(nativeCalls, 0);
    assert.deepEqual(await call(bridge, watchPath(0, first)), { status: 200, value: { sessionId, revision: 0, changed: false } });
    assert.equal(nativeCalls, 1);
});

test('an in-flight native watch keeps the Auto lease with its owning client', async (t) => {
    let now = 1_000;
    t.mock.method(performance, 'now', () => now);
    const first = randomUUID(), second = randomUUID(), sessionId = randomUUID();
    let started, complete;
    const nativeStarted = new Promise((resolve) => { started = resolve; });
    const { bridge } = await setup(t, async (_url, options) => {
        started(options.signal);
        return new Promise((resolve) => { complete = resolve; });
    });
    await claim(bridge, first, true);
    const running = call(bridge, watchPath(0, first));
    await nativeStarted;
    now += 120_000;
    await claim(bridge, second, false);
    complete(Response.json({ sessionId, revision: 0, changed: false }));
    assert.deepEqual(await running, { status: 200, value: { sessionId, revision: 0, changed: false } });
    await claim(bridge, second, false);
    now += 60_001;
    await claim(bridge, second, true);
});

test('watch passes through changes and keepalive responses with validated revisions', async (t) => {
    const sessionId = randomUUID(), clientId = randomUUID(), calls = [];
    const { bridge } = await setup(t, async (url, options) => {
        calls.push({ url, method: options.method, signal: options.signal });
        const after = Number(new URL(url).searchParams.get('after'));
        return Response.json({ sessionId, revision: 7, changed: after !== 7 });
    });
    await claim(bridge, clientId, true);
    assert.deepEqual(await call(bridge, watchPath(6, clientId)), { status: 200, value: { sessionId, revision: 7, changed: true } });
    assert.deepEqual(await call(bridge, watchPath(7, clientId)), { status: 200, value: { sessionId, revision: 7, changed: false } });
    assert.deepEqual(calls.map((entry) => [new URL(entry.url).pathname, new URL(entry.url).search, entry.method]),
        [['/watch', '?after=6', 'GET'], ['/watch', '?after=7', 'GET']]);
    assert.ok(calls.every((entry) => entry.signal instanceof AbortSignal));
});

test('watch rejects malformed revisions and inconsistent native responses', async (t) => {
    const sessionId = randomUUID(), clientId = randomUUID();
    let fetches = 0;
    const { bridge } = await setup(t, async () => {
        fetches++;
        return Response.json({ sessionId, revision: 4, changed: false });
    });
    await claim(bridge, clientId, true);
    for (const path of ['/krita/watch', watchPath(-1, clientId), watchPath('01', clientId),
        `${watchPath(1, clientId)}&after=2`, watchPath('9007199254740992', clientId)]) {
        assert.equal((await call(bridge, path)).status, 400, path);
    }
    assert.equal(fetches, 0);
    assert.equal((await call(bridge, watchPath(3, clientId))).status, 502);
    assert.equal(fetches, 1);
});

test('watch reports a disconnected Krita and accepts a later reconnect', async (t) => {
    const sessionId = randomUUID(), clientId = randomUUID();
    let connected = false;
    const { bridge } = await setup(t, async () => {
        if (!connected) throw new Error('connection refused');
        return Response.json({ sessionId, revision: 0, changed: false });
    });
    await claim(bridge, clientId, true);
    const disconnected = await call(bridge, watchPath(0, clientId));
    assert.equal(disconnected.status, 503);
    assert.match(disconnected.value.error, /Krita 未连接/);
    connected = true;
    assert.deepEqual(await call(bridge, watchPath(0, clientId)),
        { status: 200, value: { sessionId, revision: 0, changed: false } });
});

test('closing the browser watch aborts its native long poll', async (t) => {
    const clientId = randomUUID(), otherClientId = randomUUID();
    let started;
    const nativeStarted = new Promise((resolve) => { started = resolve; });
    const { bridge } = await setup(t, async (_url, options) => {
        started(options.signal);
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    });
    const owner = await claim(bridge, clientId, true);
    const response = responseOf();
    const request = requestOf(watchPath(0, clientId));
    const running = bridge.handle(request, response, '/krita/watch');
    const signal = await nativeStarted;
    assert.equal(signal.aborted, false);
    response.destroyed = true;
    response.emit('close');
    assert.equal(await running, true);
    assert.equal(signal.aborted, true);
    assert.equal(response.status, undefined);
    await claim(bridge, otherClientId, false);
    assert.deepEqual(await call(bridge, '/krita/auto/release', { projectId, clientId, leaseId: owner.leaseId }),
        { status: 200, value: { released: true } });
    await claim(bridge, otherClientId, true);
});
