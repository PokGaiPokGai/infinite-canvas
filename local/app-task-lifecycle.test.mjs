import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appTaskLifecycle } from './app-task-lifecycle.mjs';

test('app exit waits for owned task cleanup and leaves unrelated processes alive', async () => {
    const lifecycle = appTaskLifecycle();
    const start = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const owned = lifecycle.trackChild(start()), unrelated = start();
    let persisted = false;
    lifecycle.trackTask(once(owned, 'close').then(() => { persisted = true; }));
    try {
        await lifecycle.exit();
        assert.equal(persisted, true);
        assert.equal(lifecycle.exiting, true);
        assert.equal(unrelated.exitCode, null);
        assert.equal(unrelated.signalCode, null);
        assert.throws(() => lifecycle.trackChild(unrelated), /退出/);
    } finally { owned.kill(); unrelated.kill(); }
});
