import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('./comfyui-image.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const info = {
    IPAdapterModelLoader: { input: { required: { ipadapter_file: [['ip-adapter_sdxl_vit-h.safetensors']] } } },
    CLIPVisionLoader: { input: { required: { clip_name: [['clip-vision_vit-h.safetensors']] } } },
    IPAdapterAdvanced: { input: { required: { weight_type: [['style transfer']] } } },
};

async function run({ images = [], roles = [], comfy = {}, objectInfo = info } = {}) {
    const submissions = [];
    let uploads = 0;
    const request = async ({ url, data }) => {
        if (url.endsWith('/object_info')) return objectInfo;
        if (url.endsWith('/upload/image')) return { name: `source-${++uploads}.png`, subfolder: 'InfiniteCanvas' };
        if (url.endsWith('/prompt')) {
            submissions.push(data.prompt);
            return { prompt_id: 'job' };
        }
        if (url.endsWith('/history/job')) return { job: { outputs: { '7': { images: [{ filename: 'result.png', subfolder: 'InfiniteCanvas', type: 'output' }] } } } };
        throw new Error(`Unexpected request: ${url}`);
    };
    const evaluate = new AsyncFunction('prompt', 'images', 'params', 'model', 'baseUrl', 'request', 'fetch', 'createImageBitmap', 'poll', 'signal', 'crypto', script);
    const generate = () => evaluate('sample prompt', images, { count: 1, comfy, referenceRoles: roles }, 'model.safetensors', 'http://127.0.0.1:3000/comfy',
        request, async () => ({ blob: async () => new Blob(['image'], { type: 'image/png' }) }),
        async () => ({ width: 1024, height: 768, close() {} }),
        async (get, extract) => extract(await get()), undefined, globalThis.crypto);
    return { generate, submissions, get uploads() { return uploads; } };
}

test('text-only generation retains an empty latent and full denoise', async () => {
    const task = await run();
    const result = await task.generate();
    assert.equal(task.submissions.length, 1);
    assert.equal(task.submissions[0]['4'].class_type, 'EmptyLatentImage');
    assert.equal(task.submissions[0]['5'].inputs.denoise, 1);
    assert.equal(result.length, 1);
});

test('one source and multiple style references use img2img and chained IP-Adapter', async () => {
    const task = await run({ images: ['source', 'style-a', 'style-b'], roles: ['composition', 'style', 'style'],
        comfy: { denoise: 0.35, steps: 20, cfg: 7, styleWeight: 0.6 } });
    await task.generate();
    const graph = task.submissions[0];
    assert.equal(graph['4'].class_type, 'RepeatLatentBatch');
    assert.equal(graph['5'].inputs.denoise, 0.35);
    assert.equal(graph['5'].inputs.steps, 20);
    assert.deepEqual(graph['5'].inputs.model, ['23', 0]);
    assert.equal(graph['21'].inputs.weight, 0.3);
    assert.equal(graph['23'].inputs.weight, 0.3);
});

test('unsupported roles and multiple source images never submit a task', async () => {
    const unsupported = await run({ images: ['mask'], roles: ['mask'] });
    await assert.rejects(unsupported.generate(), /不能直接使用/);
    assert.equal(unsupported.submissions.length, 0);
    const ambiguous = await run({ images: ['a', 'b'], roles: ['reference', 'composition'] });
    await assert.rejects(ambiguous.generate(), /只能指定一张改绘底图/);
    assert.equal(ambiguous.submissions.length, 0);
});
