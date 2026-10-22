import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createKritaBridge } from './krita-bridge.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const otherPng = Buffer.from(png);
otherPng[otherPng.length - 1] ^= 1;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requestOf(body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = 'POST';
    request.headers = { 'x-infinite-canvas-krita-ui': '1', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
    return request;
}

async function call(bridge, path, body) {
    let status, value;
    const response = { writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); } };
    assert.equal(await bridge.handle(requestOf(body), response, path), true);
    return { status, value };
}

test('arbitrary PNG write uses the selected snapshot and creates one layer per command', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), snapshotId = randomUUID(), layerId = randomUUID(), anchorId = randomUUID();
        const layerPixelSha256 = sha256(Buffer.from('written layer pixels'));
        const applies = [];
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshotId, sessionId: randomUUID(), documentId,
                documentName: 'test.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8', colorProfile: 'sRGB-elle-V2-srgbtrc.icc',
                sha256: sha256(png), createdAt: new Date().toISOString(), imageBase64: png.toString('base64') });
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                applies.push(payload);
                return Response.json({ commandId: payload.commandId, documentId, layerId, layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const commandId = randomUUID();
        const payload = { snapshotId, commandId, imageBase64: png.toString('base64'), insertAboveLayerId: anchorId };
        const first = await call(bridge, '/krita/image-returns', payload);
        assert.deepEqual(first, { status: 200, value: { commandId, documentId, layerId, layerPixelSha256 } });
        assert.equal(applies.length, 1);
        assert.equal(applies[0].insertAboveLayerId, anchorId);
        assert.equal(applies[0].writeMode, 'insert');
        assert.equal(applies[0].sha256, sha256(png));
        assert.deepEqual(await readFile(join(linkRoot, 'returns', `${commandId}.png`)), png);
        assert.deepEqual(await call(bridge, '/krita/image-returns', payload), first);
        assert.equal(applies.length, 1);
        assert.equal((await call(bridge, '/krita/image-returns', { ...payload, insertAboveLayerId: randomUUID() })).status, 409);
        assert.equal((await call(bridge, '/krita/image-returns', { ...payload, imageBase64: otherPng.toString('base64') })).status, 409);
        assert.equal(applies.length, 1);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('replace mode freezes its target, backs up the layer, and refuses a changed command', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), snapshotId = randomUUID(), layerId = randomUUID(), targetId = randomUUID();
        const pixelSha256 = sha256(Buffer.from('original layer pixels'));
        const layerPixelSha256 = sha256(Buffer.from('written layer pixels'));
        const backups = [], applies = [];
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshotId, sessionId: randomUUID(), documentId,
                documentName: 'test.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8', colorProfile: 'sRGB-elle-V2-srgbtrc.icc',
                sha256: sha256(png), createdAt: new Date().toISOString(), imageBase64: png.toString('base64') });
            if (url.endsWith('/layer-backup')) {
                backups.push(JSON.parse(options.body));
                return Response.json({ documentId, layerId: targetId, width: 1, height: 1, sha256: sha256(png),
                    pixelSha256, imageBase64: png.toString('base64') });
            }
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                applies.push(payload);
                return Response.json({ commandId: payload.commandId, documentId, layerId: targetId, layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const commandId = randomUUID();
        const payload = { snapshotId, commandId, imageBase64: png.toString('base64'), writeMode: 'replace', replaceLayerId: targetId };
        assert.equal((await call(bridge, '/krita/image-returns', { ...payload, insertAboveLayerId: layerId })).status, 400);
        const first = await call(bridge, '/krita/image-returns', payload);
        assert.deepEqual(first, { status: 200, value: { commandId, documentId, layerId: targetId, layerPixelSha256 } });
        assert.deepEqual(backups, [{ snapshotId, layerId: targetId }]);
        assert.deepEqual(await readFile(join(linkRoot, 'returns', `${commandId}.before.png`)), png);
        assert.equal(applies.length, 1);
        assert.equal(applies[0].writeMode, 'replace');
        assert.equal(applies[0].replaceLayerId, targetId);
        assert.equal(applies[0].expectedLayerSha256, pixelSha256);
        const journal = JSON.parse(await readFile(join(linkRoot, 'returns', `${commandId}.json`), 'utf8'));
        assert.equal(journal.backupSha256, sha256(png));
        assert.equal(journal.expectedLayerSha256, pixelSha256);
        assert.deepEqual(await call(bridge, '/krita/image-returns', payload), first);
        assert.equal(backups.length, 1);
        assert.equal(applies.length, 1);
        assert.equal((await call(bridge, '/krita/image-returns', { ...payload, replaceLayerId: randomUUID() })).status, 409);
        await writeFile(join(linkRoot, 'returns', `${commandId}.before.png`), otherPng);
        assert.equal((await call(bridge, '/krita/image-returns', payload)).status, 500);
        assert.equal(applies.length, 1);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('replace retries reuse the original backup hash after Krita rejects a changed layer', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), snapshotId = randomUUID(), targetId = randomUUID();
        let backups = 0, applies = 0;
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshotId, sessionId: randomUUID(), documentId,
                documentName: 'test.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8', colorProfile: 'sRGB-elle-V2-srgbtrc.icc',
                sha256: sha256(png), createdAt: new Date().toISOString(), imageBase64: png.toString('base64') });
            if (url.endsWith('/layer-backup')) {
                backups++;
                return Response.json({ documentId, layerId: targetId, width: 1, height: 1, sha256: sha256(png),
                    pixelSha256: sha256(Buffer.from('original layer pixels')), imageBase64: png.toString('base64') });
            }
            if (url.endsWith('/apply')) {
                applies++;
                return Response.json({ error: '目标图层已改变' }, { status: 409 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const commandId = randomUUID();
        const payload = { snapshotId, commandId, imageBase64: png.toString('base64'), writeMode: 'replace', replaceLayerId: targetId };
        assert.equal((await call(bridge, '/krita/image-returns', payload)).status, 409);
        assert.equal((await call(bridge, '/krita/image-returns', payload)).status, 409);
        assert.equal(backups, 1);
        assert.equal(applies, 2);
        assert.deepEqual(await readFile(join(linkRoot, 'returns', `${commandId}.before.png`)), png);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('one delivery reuses the completed command across windows and equivalent snapshots', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), otherDocumentId = randomUUID(), sessionId = randomUUID();
        const firstSnapshot = randomUUID(), secondSnapshot = randomUUID(), otherSnapshot = randomUUID();
        const layerId = randomUUID(), anchorId = randomUUID(), deliveryId = randomUUID();
        const layerPixelSha256 = sha256(Buffer.from('written pixels'));
        const snapshots = [{ id: firstSnapshot, documentId }, { id: secondSnapshot, documentId },
            { id: otherSnapshot, documentId: otherDocumentId }];
        const applies = [];
        const fetchImpl = async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ ...snapshots.shift(), sessionId,
                documentName: 'same-document.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8',
                colorProfile: 'sRGB-elle-V2-srgbtrc.icc', sha256: sha256(png), createdAt: new Date().toISOString(),
                imageBase64: png.toString('base64') });
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                applies.push(payload);
                return Response.json({ commandId: payload.commandId, documentId, layerId, layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        };
        const bridge = createKritaBridge({ appRoot, fetchImpl });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        assert.equal((await call(bridge, '/krita/snapshots', { documentId: otherDocumentId })).status, 201);
        const commandId = randomUUID();
        const firstPayload = { snapshotId: firstSnapshot, commandId, deliveryId,
            imageBase64: png.toString('base64'), insertAboveLayerId: anchorId };
        const first = await call(bridge, '/krita/image-returns', firstPayload);
        assert.deepEqual(first, { status: 200, value: { commandId, documentId, layerId, layerPixelSha256 } });
        const secondPayload = { ...firstPayload, snapshotId: secondSnapshot, commandId: randomUUID() };
        assert.deepEqual(await call(bridge, '/krita/image-returns', secondPayload), first);
        assert.deepEqual(await call(createKritaBridge({ appRoot, fetchImpl }), '/krita/image-returns', secondPayload), first);
        assert.equal(applies.length, 1);
        assert.equal((await call(bridge, '/krita/image-returns', { ...secondPayload, imageBase64: otherPng.toString('base64') })).status, 409);
        assert.equal((await call(bridge, '/krita/image-returns', { ...secondPayload, insertAboveLayerId: randomUUID() })).status, 409);
        assert.equal((await call(bridge, '/krita/image-returns', { ...secondPayload, fitToCanvas: true })).status, 409);
        assert.equal((await call(bridge, '/krita/image-returns', { ...secondPayload, snapshotId: otherSnapshot })).status, 409);
        assert.equal(applies.length, 1);
        const record = JSON.parse(await readFile(join(linkRoot, 'returns', `delivery-${deliveryId}.json`), 'utf8'));
        assert.equal(record.commandId, commandId);
        assert.equal(record.snapshotId, firstSnapshot);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('unconfirmed delivery refuses a different snapshot and retries the original command', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), sessionId = randomUUID(), firstSnapshot = randomUUID(), secondSnapshot = randomUUID();
        const layerId = randomUUID(), layerPixelSha256 = sha256(Buffer.from('written pixels'));
        const snapshots = [firstSnapshot, secondSnapshot];
        let applies = 0;
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshots.shift(), sessionId, documentId,
                documentName: 'same-document.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8',
                colorProfile: 'sRGB-elle-V2-srgbtrc.icc', sha256: sha256(png), createdAt: new Date().toISOString(),
                imageBase64: png.toString('base64') });
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                applies++;
                return applies === 1 ? Response.json({ error: 'connection lost' }, { status: 503 })
                    : Response.json({ commandId: payload.commandId, documentId, layerId, layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const commandId = randomUUID(), deliveryId = randomUUID();
        const payload = { snapshotId: firstSnapshot, commandId, deliveryId, imageBase64: png.toString('base64') };
        assert.equal((await call(bridge, '/krita/image-returns', payload)).status, 502);
        assert.equal((await call(bridge, '/krita/image-returns', { ...payload, commandId: randomUUID(), snapshotId: secondSnapshot })).status, 409);
        assert.equal(applies, 1);
        assert.deepEqual(await call(bridge, '/krita/image-returns', payload),
            { status: 200, value: { commandId, documentId, layerId, layerPixelSha256 } });
        assert.equal(applies, 2);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('managed result layer refuses overwrite after its pixels changed', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), snapshotId = randomUUID(), targetId = randomUUID();
        const priorHash = sha256(Buffer.from('last written pixels'));
        const changedHash = sha256(Buffer.from('user-painted pixels'));
        const layerPixelSha256 = sha256(Buffer.from('new written pixels'));
        let backups = 0, applies = 0, currentHash = changedHash;
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshotId, sessionId: randomUUID(), documentId,
                documentName: 'test.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8',
                colorProfile: 'sRGB-elle-V2-srgbtrc.icc', sha256: sha256(png), createdAt: new Date().toISOString(),
                imageBase64: png.toString('base64') });
            if (url.endsWith('/layer-backup')) {
                backups++;
                return Response.json({ documentId, layerId: targetId, width: 1, height: 1, sha256: sha256(png),
                    pixelSha256: currentHash, imageBase64: png.toString('base64') });
            }
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                applies++;
                return Response.json({ commandId: payload.commandId, documentId, layerId: targetId, layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const payload = { snapshotId, commandId: randomUUID(), deliveryId: randomUUID(),
            imageBase64: png.toString('base64'), writeMode: 'replace', replaceLayerId: targetId,
            expectedPriorLayerSha256: priorHash };
        assert.equal((await call(bridge, '/krita/image-returns', payload)).status, 409);
        assert.equal(backups, 1);
        assert.equal(applies, 0);
        currentHash = priorHash;
        const safe = { ...payload, commandId: randomUUID(), deliveryId: randomUUID() };
        assert.deepEqual(await call(bridge, '/krita/image-returns', safe),
            { status: 200, value: { commandId: safe.commandId, documentId, layerId: targetId, layerPixelSha256 } });
        assert.equal(applies, 1);
        assert.equal((await call(bridge, '/krita/image-returns', { ...safe, expectedPriorLayerSha256: changedHash })).status, 409);
        assert.equal(applies, 1);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});

test('separate image commands for one Krita document apply sequentially', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'infinite-canvas-krita-test-'));
    try {
        const linkRoot = join(appRoot, '.local', 'krita-link');
        await mkdir(linkRoot, { recursive: true });
        await writeFile(join(linkRoot, 'connection.json'), JSON.stringify({ version: 1, port: 3003, token: 'test-token' }));
        const documentId = randomUUID(), sessionId = randomUUID(), firstSnapshot = randomUUID(), secondSnapshot = randomUUID();
        const layerPixelSha256 = sha256(Buffer.from('written pixels'));
        const snapshots = [firstSnapshot, secondSnapshot];
        let active = 0, peak = 0, firstApply = true, started;
        const firstStarted = new Promise((resolve) => { started = resolve; });
        let release;
        const holdFirst = new Promise((resolve) => { release = resolve; });
        const bridge = createKritaBridge({ appRoot, fetchImpl: async (url, options) => {
            if (url.endsWith('/snapshot')) return Response.json({ id: snapshots.shift(), sessionId, documentId,
                documentName: 'test.kra', width: 1, height: 1, colorModel: 'RGBA', colorDepth: 'U8',
                colorProfile: 'sRGB-elle-V2-srgbtrc.icc', sha256: sha256(png), createdAt: new Date().toISOString(),
                imageBase64: png.toString('base64') });
            if (url.endsWith('/apply')) {
                const payload = JSON.parse(options.body);
                peak = Math.max(peak, ++active);
                if (firstApply) { firstApply = false; started(); await holdFirst; }
                active--;
                return Response.json({ commandId: payload.commandId, documentId, layerId: randomUUID(), layerPixelSha256 });
            }
            throw new Error(`Unexpected ${url}`);
        } });
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        assert.equal((await call(bridge, '/krita/snapshots', { documentId })).status, 201);
        const first = call(bridge, '/krita/image-returns', { snapshotId: firstSnapshot, commandId: randomUUID(), imageBase64: png.toString('base64') });
        await firstStarted;
        const second = call(bridge, '/krita/image-returns', { snapshotId: secondSnapshot, commandId: randomUUID(), imageBase64: png.toString('base64') });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const peakBeforeRelease = peak;
        release();
        assert.equal((await first).status, 200);
        assert.equal((await second).status, 200);
        assert.equal(peakBeforeRelease, 1);
        assert.equal(peak, 1);
    } finally {
        const checked = resolve(appRoot);
        assert.equal(dirname(checked), resolve(tmpdir()));
        assert.match(basename(checked), /^infinite-canvas-krita-test-/);
        await rm(checked, { recursive: true, force: true });
    }
});
