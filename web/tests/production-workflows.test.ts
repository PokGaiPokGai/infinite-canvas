import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasNodeData } from '../src/types/canvas';
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'zh-CN', setItem: () => {} } });
const { prepareBatch } = await import('../src/lib/canvas/production-runner');
const { cloneWorkflowGraph, validateWorkflow } = await import('../src/lib/canvas/workflow-graph');
const { unsupportedNodeTypes } = await import('../src/lib/canvas/project-capabilities');
const { hydrateCanvasImages, resetInterruptedGeneration } = await import('../src/lib/canvas/canvas-generation-helpers');
const node = (id: string, type = 'image'): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: 'fixture', status: 'success' } });

test('batch matrix expands inputs, freezes settings and preserves reference roles', () => {
    const settings = { mode: 'image' as const, prompt: '{input} {index}', inputText: 'rock\nwall', model: 'fake-model', size: '', axes: [{ field: 'seed' as const, values: ['1', '2'] }, { field: 'cfg' as const, values: ['3', '4'] }] };
    const rows = prepareBatch(settings, [node('reference')], 'fake-model', [{ id: 'edge', fromNodeId: 'reference', toNodeId: 'batch', role: 'composition' }]);
    assert.equal(rows.length, 12);
    assert.deepEqual(rows[0].config.comfy, { seed: 1, cfg: 3 });
    assert.equal(rows[8].references[0].role, 'composition');
    settings.prompt = 'changed';
    assert.equal(rows[0].config.prompt, 'rock 1');
    assert.throws(() => prepareBatch({ ...settings, axes: [{ field: 'steps', values: ['-1'] }] }, [], 'fake'), /无效数值/);
});

test('workflow clones isolate nodes and remap public ports, prompt references and mask selectors', () => {
    const image = node('image'), mask = node('mask', 'process:mask-extract');
    mask.metadata = { composerContent: '@[node:image]', maskSettings: { imageId: 'image' } };
    const workflow = { name: 'fixture', nodes: [image, mask], connections: [{ id: 'edge', fromNodeId: 'image', toNodeId: 'mask' }], inputs: [{ id: 'in', nodeId: 'image', name: 'image', kind: 'image' as const }], outputs: [{ id: 'out', nodeId: 'mask', name: 'mask' }], parameters: [] };
    const clone = cloneWorkflowGraph(workflow);
    assert.notEqual(clone.nodes[0].id, image.id);
    assert.equal(clone.connections[0].fromNodeId, clone.nodes[0].id);
    assert.equal(clone.nodes[1].metadata?.maskSettings?.imageId, clone.nodes[0].id);
    assert.equal(clone.nodes[1].metadata?.composerContent, `@[node:${clone.nodes[0].id}]`);
    assert.equal(clone.outputs[0].nodeId, clone.nodes[1].id);
    clone.nodes[0].metadata!.content = 'changed';
    assert.equal(image.metadata!.content, 'fixture');
    assert.throws(() => validateWorkflow({ ...workflow, connections: [...workflow.connections, { id: 'cycle', fromNodeId: 'mask', toNodeId: 'image' }] }), /循环/);
});

test('unsupported capabilities include nested workflows without altering stored nodes', () => {
    const nodes = [node('image'), { ...node('workflow', 'process:workflow'), metadata: { workflow: { name: 'fixture', nodes: [node('future', 'process:future')], connections: [], inputs: [], outputs: [], parameters: [], bindings: {}, values: {} } } }];
    const before = structuredClone(nodes);
    assert.deepEqual(unsupportedNodeTypes(nodes, type => ['image', 'process:workflow'].includes(type)), ['process:future']);
    assert.deepEqual(nodes, before);
});

test('opening a second window does not mark another window running batch as failed', async () => {
    const rows = prepareBatch({ mode: 'text', prompt: '{input}', inputText: 'fixture', model: 'fake', size: '', axes: [] }, [], 'fake');
    rows[0].state = 'running';
    const batch = { ...node('batch', 'process:batch'), metadata: { status: 'loading' as const, batchRows: rows } };
    const [restored] = await hydrateCanvasImages(resetInterruptedGeneration([batch]));
    assert.equal(restored.metadata?.status, 'loading');
    assert.equal(restored.metadata?.batchRows?.[0].state, 'running');
    assert.equal(restored.metadata?.errorDetails, undefined);
});
