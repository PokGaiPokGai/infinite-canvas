import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tests = directory => readdirSync(join(root, directory)).filter(name => /\.test\.(mjs|ts)$/.test(name)).map(name => join(root, directory, name));
const node = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'local/test-register.mjs')).href, '--test', ...tests('local'), ...tests('web/tests')], { cwd: root, stdio: 'inherit', windowsHide: true });
let failed = node.status !== 0 || !!node.error;
for (const file of ['krita-auto-delay.test.py']) {
    const result = spawnSync(process.env.PYTHON || 'python', [join(root, 'local', file)], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) console.error(`${file}: Python 未就绪；可用 PYTHON 指定已有解释器。`);
    failed ||= result.status !== 0 || !!result.error;
}
console.log('Blender 集成验收需独立 Blender 测试进程；离线检查未调用当前 Blender 或真实生成模型。');
process.exitCode = failed ? 1 : 0;
