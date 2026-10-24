import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Test storage is created by the test itself. Never point a fixture at the shared application database.
export async function withTestDirectory(run) {
    const directory = await mkdtemp(join(tmpdir(), 'infinite-canvas-test-'));
    const marker = randomUUID();
    await writeFile(join(directory, '.test-owner'), marker);
    try { return await run(directory); }
    finally {
        if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('infinite-canvas-test-') || await readFile(join(directory, '.test-owner'), 'utf8') !== marker) throw new Error('测试目录归属不匹配，拒绝清理。');
        await rm(directory, { recursive: true, force: true });
    }
}
