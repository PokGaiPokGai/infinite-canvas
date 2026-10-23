import { REFERENCE_PACK, referencePackText } from "@/lib/canvas/canvas-production";
import type { AiTextMessage } from "@/services/api/image";
import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasInputRole, type CanvasNodeData } from "@/types/canvas";
import { getGenerationResourceConnections, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { canvasInputRoleLabel, isImageLinkNode, isKritaReadInputNode, isKritaWriteInputNode } from "@/lib/canvas/canvas-input-role";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getCanvasConfigOutput } from "@/lib/canvas/canvas-config-output";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceBindings: NodeGenerationReferenceBinding[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export function supportsLocalComfyControls(config: AiConfig, model: string) {
    const baseUrl = resolveModelRequestConfig(config, model).baseUrl.trim();
    const script = resolveModelScript(config, model);
    return Boolean(script.includes("params.comfy") && script.includes("params.referenceRoles") && (/\/comfy\/?$/i.test(baseUrl) || /^https?:\/\/(?:127\.0\.0\.1|localhost):8188\/?$/i.test(baseUrl)));
}

export type NodeGenerationReferenceBinding = {
    connectionId?: string;
    sourceNodeId: string;
    role: CanvasInputRole;
    instruction?: string;
    order?: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    connectionId?: string;
    role?: CanvasConnection["role"];
    instruction?: string;
    order?: number;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    alwaysInclude?: boolean;
    title: string;
    children: NodeGenerationResourceInput[];
};

export type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, imageIndexOffset = 0): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt, imageIndexOffset);
    }

    const resourceInputs = flattenGenerationInputs(inputs);
    let textIndex = 0;
    const upstreamText = resourceInputs.flatMap((input) => (input.text ? [textBlock(generationLabel("text", textIndex++), input.text)] : [])).join("\n\n");
    const imageInputs = resourceInputs.filter((input) => Boolean(input.image));
    const referenceImages = imageInputs.map((input) => input.image as ReferenceImage);
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: addImageRoleInstructions(upstreamText ? `${prompt}\n\n${upstreamText}` : prompt, imageInputs, imageIndexOffset),
        referenceImages,
        referenceBindings: imageInputs.map(imageBinding),
        referenceVideos,
        referenceAudios,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, imageIndexOffset: number): NodeGenerationContext {
    const inputByNodeId = new Map<string, NodeGenerationInput>();
    for (const input of inputs) if (!inputByNodeId.has(input.nodeId)) inputByNodeId.set(input.nodeId, input);
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            const labels = flattenGenerationInputs([input]).map((resource) => {
                let label = labelByNodeId.get(resource.nodeId);
                if (!label) {
                    label = generationLabel(resource.type, counts[resource.type]++);
                    labelByNodeId.set(resource.nodeId, label);
                    if (resource.type === "text") textBlocks.push(textBlock(label, resource.text || ""));
                    else selectedInputs.push(resource);
                }
                return resource.type === "text" ? `【${label}】` : label;
            });
            nextPrompt += labels.join("、");
        }
        lastIndex = match.index + match[0].length;
    }

    for (const input of inputs) {
        if (input.type !== "group" || !input.alwaysInclude) continue;
        for (const resource of input.children) {
            if (labelByNodeId.has(resource.nodeId)) continue;
            const label = generationLabel(resource.type, counts[resource.type]++);
            labelByNodeId.set(resource.nodeId, label);
            if (resource.type === "text") textBlocks.push(textBlock(label, resource.text || ""));
            else selectedInputs.push(resource);
        }
    }
    const connectedRoleImages = flattenGenerationInputs(inputs).filter((input) => input.image && input.role && !labelByNodeId.has(input.nodeId));
    selectedInputs.push(...connectedRoleImages);
    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const imageInputs = selectedInputs.filter((input) => Boolean(input.image));
    const referenceImages = imageInputs.map((input) => input.image as ReferenceImage);
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken && !connectedRoleImages.length && !selectedInputs.length && !textBlocks.length) {
        return {
            prompt,
            referenceImages: [],
            referenceBindings: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: addImageRoleInstructions(nextPrompt, imageInputs, imageIndexOffset),
        referenceImages,
        referenceBindings: imageInputs.map(imageBinding),
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceConnections(nodeId, nodes, connections).flatMap(({ node, connection }): NodeGenerationInput[] => {
        if (node.type === REFERENCE_PACK && node.metadata?.referencePack) {
            const pack = node.metadata.referencePack;
            const children: NodeGenerationResourceInput[] = [{ nodeId: `${node.id}:rules`, type: "text", title: pack.name, text: referencePackText(pack) }, ...pack.images.filter(image => image.content || image.storageKey).map(image => ({ nodeId: `${node.id}:${image.id}`, type: "image" as const, title: image.title, connectionId: connection.id, role: connection.role || (pack.kind === "character" ? "character" as const : "style" as const), instruction: connection.instruction, image: { id: `${node.id}:${image.id}`, name: image.title, type: image.mimeType || "image/png", dataUrl: image.content || "", storageKey: image.storageKey } }))];
            return [{ nodeId: node.id, type: "group", title: pack.name || node.title, alwaysInclude: true, children }];
        }
        const resources = node.type === CanvasNodeType.Group ? [] : readNodeGenerationResource(node);
        // Older Krita connections may have been created before the first snapshot, without a role.
        // Give only an actual image from a read node the default role; other legacy edges keep their semantics.
        const role: CanvasInputRole | undefined = connection.role ?? ((isImageLinkNode(node) || isKritaReadInputNode(node) || isKritaWriteInputNode(node)) && resources.some((input) => input.type === "image") ? "reference" : undefined);
        const edgeInput = { connectionId: connection.id, role, instruction: connection.instruction, order: connection.order };
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes).flatMap(readNodeGenerationResource).map((input) => ({ ...input, ...edgeInput }));
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return resources.map((input) => ({ ...input, ...edgeInput }));
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    const byNodeId = new Map<string, NodeGenerationResourceInput>();
    for (const input of resources) if (!byNodeId.has(input.nodeId)) byNodeId.set(input.nodeId, input);
    return [...byNodeId.values()];
}

function addImageRoleInstructions(prompt: string, imageInputs: NodeGenerationResourceInput[], imageIndexOffset: number) {
    const lines = imageInputs.flatMap((input, index) => {
        const role = input.role || "reference";
        const instruction = input.instruction?.trim();
        if (role === "reference" && !instruction) return [];
        const label = role === "reference" ? "普通参考" : `${canvasInputRoleLabel(role)}参考${role === "mask" ? "（仅作为描述，不是像素级遮罩）" : ""}`;
        return [`${imageReferenceLabel(index + imageIndexOffset)}：${label}${instruction ? `；${instruction}` : ""}`];
    });
    return lines.length ? `${prompt}\n\n参考图用途（按图片编号对应）：\n${lines.join("\n")}` : prompt;
}

function imageBinding(input: NodeGenerationResourceInput): NodeGenerationReferenceBinding {
    return { connectionId: input.connectionId, sourceNodeId: input.nodeId, role: input.role || "reference", instruction: input.instruction?.trim() || undefined, order: input.order };
}

function readNodeGenerationResource(node: CanvasNodeData): NodeGenerationResourceInput[] {
    if (node.type === CanvasNodeType.Config) {
        const output = getCanvasConfigOutput(node);
        if (!output) return [];
        if (output.kind === "text") return [{ nodeId: node.id, type: "text", title: node.title, text: output.content }];
        if (output.kind === "image") return [{ nodeId: node.id, type: "image", title: node.title, image: { id: node.id, name: `${node.title || node.id}.png`, type: output.mimeType || "image/png", dataUrl: output.content, storageKey: output.storageKey } }];
        if (output.kind === "video") return [{ nodeId: node.id, type: "video", title: node.title, video: { id: node.id, name: `${node.title || node.id}.mp4`, type: output.mimeType || "video/mp4", url: output.content, storageKey: output.storageKey, bytes: output.bytes, width: output.naturalWidth, height: output.naturalHeight, durationMs: output.durationMs } }];
        return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id: node.id, name: `${node.title || node.id}.mp3`, type: output.mimeType || "audio/mpeg", url: output.content, storageKey: output.storageKey, durationMs: output.durationMs } }];
    }
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image", title: node.title, image }];
    const video = readReferenceVideo(node);
    if (video) return [{ nodeId: node.id, type: "video", title: node.title, video }];
    const audio = readReferenceAudio(node);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.title, audio }];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if (resource?.kind === "image" && resource.url) return [{ nodeId: node.id, type: "image", title: node.title, image: { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "video" && resource.url) return [{ nodeId: node.id, type: "video", title: node.title, video: { id: node.id, name: `${node.title || node.id}.mp4`, type: node.metadata?.mimeType || "video/mp4", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "audio" && resource.url) return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id: node.id, name: `${node.title || node.id}.mp3`, type: node.metadata?.mimeType || "audio/mpeg", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "text" && resource.text) return [{ nodeId: node.id, type: "text", title: node.title, text: resource.text }];
    const text = readNodeTextInput(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function textBlock(label: string, text: string) {
    return `【${label}】\n${text}`;
}

function generationLabel(type: NodeGenerationResourceInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
