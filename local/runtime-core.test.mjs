import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkout, runtimeEndpoint, verifyBuild, sourceFingerprint, buildDirectory, verifyDependencies, readInstance } from './runtime-core.mjs';
import { withTestDirectory } from './test-fixture.mjs';

test('main stays on 3000 despite old instance configuration; feature checkouts keep their own port', () => withTestDirectory(async root => {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'ignore' });
    git('init', '--initial-branch=main');
    git('-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    assert.equal(readInstance(root).port, 3000);
    await mkdir(join(root, '.local'));
    await writeFile(join(root, '.local/instance.json'), '{"port":3070}');
    assert.equal(readInstance(root).port, 3000);
    git('checkout', '-b', 'codex/runtime-test');
    assert.equal(readInstance(root).port, 3070);
    await writeFile(join(root, '.local/instance.json'), '{"port":3000}');
    assert.throws(() => readInstance(root), /不能占用 3000/);
}));

test('build mode and source fingerprint detect the wrong build and uncommitted source changes', () => withTestDirectory(async root => {
    execFileSync('git', ['init', '--initial-branch=codex/runtime-test', root], { windowsHide: true, stdio: 'ignore' });
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web/source.ts'), 'export const value = 1;');
    const directory = buildDirectory(root);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.html'), '<main />');
    const manifest = { head: checkout(root).head, mode: 'local-shared', fingerprint: sourceFingerprint(root) };
    await writeFile(join(directory, 'canvas-build.json'), JSON.stringify(manifest));
    assert.deepEqual(verifyBuild(root), manifest);
    await writeFile(join(directory, 'canvas-build.json'), JSON.stringify({ ...manifest, mode: 'browser' }));
    assert.throws(() => verifyBuild(root), /不一致/);
    await writeFile(join(directory, 'canvas-build.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'web/source.ts'), 'export const value = 2;');
    assert.throws(() => verifyBuild(root), /不一致/);
}));

test('installed dependency lock is checked on every launch, with Windows newline normalization', () => withTestDirectory(async root => {
    await mkdir(join(root, 'web/node_modules/vite/bin'), { recursive: true });
    await mkdir(join(root, 'web/node_modules/.pnpm'), { recursive: true });
    await writeFile(join(root, 'web/node_modules/vite/bin/vite.js'), '');
    await writeFile(join(root, 'web/package.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'web/pnpm-lock.yaml'), 'lockfileVersion: 9\r\n');
    await writeFile(join(root, 'web/node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n');
    assert.ok(verifyDependencies(root));
    await writeFile(join(root, 'web/node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 8\n');
    assert.throws(() => verifyDependencies(root), /已安装依赖/);
}));

test('identity never exposes the owner nonce; shutdown rejects foreign origins, wrong tokens and active tasks', () => {
    let stopped = 0, active = 1;
    const handler = runtimeEndpoint({ root: process.cwd(), dataRoot: process.cwd(), port: 3080, mode: 'development', token: 'owned-secret', active: () => active, stop: () => stopped++ });
    const call = (url, headers = {}, method = 'GET') => {
        const response = new EventEmitter();
        response.writeHead = (status) => { response.status = status; };
        response.end = bytes => { response.body = JSON.parse(bytes); response.emit('finish'); };
        handler({ url, method, headers: { host: '127.0.0.1:3080', ...headers } }, response, () => assert.fail('Unexpected route'));
        return response;
    };
    const identity = call('/__canvas').body;
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.branch, checkout(process.cwd()).branch);
    assert.ok(!JSON.stringify(identity).includes('owned-secret'));
    assert.equal(call('/__canvas/stop', { 'x-canvas-owner': 'wrong' }, 'POST').status, 403);
    assert.equal(call('/__canvas/stop', { 'x-canvas-owner': 'owned-secret', origin: 'https://outside.invalid' }, 'POST').status, 403);
    assert.equal(call('/__canvas/stop', { 'x-canvas-owner': 'owned-secret' }, 'POST').status, 409);
    assert.equal(stopped, 0);
    active = 0;
    assert.equal(call('/__canvas/stop', { 'x-canvas-owner': 'owned-secret' }, 'POST').status, 200);
    assert.equal(stopped, 1);
});

test('explicit app exit requires ownership and finishes cancellation before stopping', async () => {
    const order = [];
    const handler = runtimeEndpoint({ root: process.cwd(), dataRoot: process.cwd(), port: 3080, mode: 'bridge', token: 'owner', active: () => 1,
        exitApp: async () => { await Promise.resolve(); order.push('cancelled'); }, stop: () => order.push('stopped') });
    const call = (token) => new Promise(resolve => {
        const response = new EventEmitter();
        response.writeHead = status => { response.status = status; };
        response.end = () => { response.emit('finish'); resolve(response.status); };
        handler({ url: '/__canvas/stop', method: 'POST', headers: { host: '127.0.0.1:3080', 'x-canvas-owner': token, 'x-canvas-exit-app': '1' } }, response, () => assert.fail());
    });
    assert.equal(await call('foreign'), 403);
    assert.deepEqual(order, []);
    assert.equal(await call('owner'), 200);
    assert.deepEqual(order, ['cancelled', 'stopped']);
});
