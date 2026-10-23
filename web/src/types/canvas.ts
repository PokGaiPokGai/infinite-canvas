import type { ReferencePack, ExportPreset, ProductionImage } from "./canvas-production";
import type { MaskSettings, BatchSettings, BatchRow, WorkflowSettings, ProcessResult } from "./canvas-workflow";
import type { KritaNodeMetadata } from "@/types/krita-link";
import type { BlenderLinkMetadata } from "@/types/blender-link";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasMediaOutput = {
    content: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    durationMs?: number;
};

export type CanvasNodeMetadata = {
    maskSettings?: MaskSettings;
    processOutputKey?: string;
    processInputKey?: string;
    outputKind?: "image" | "text";
    batchSettings?: BatchSettings;
    batchRows?: BatchRow[];
    workflow?: WorkflowSettings;
    processResults?: ProcessResult[];
    selectedProcessResultId?: string;
    referencePack?: ReferencePack;
    exportPreset?: ExportPreset;
    productionInputs?: ProductionImage[];
    versionStack?: { memberIds: string[]; selectedId?: string };
    stackInputs?: ({ nodeId: string; title: string } & Partial<CanvasMediaOutput> & { status?: string })[];
    comparison?: { aId?: string; bId?: string; mode?: "slider" | "toggle"; selected?: "a" | "b" };
    comparisonInputs?: ({ nodeId: string; title: string } & Partial<CanvasMediaOutput>)[];
    blender?: BlenderLinkMetadata;
    krita?: KritaNodeMetadata;
    comfy?: { negativePrompt?: string; denoise?: number; steps?: number; cfg?: number; seed?: number; sampler?: string; scheduler?: string; styleWeight?: number };
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    referenceManifest?: CanvasGenerationInputRecord[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    outputImages?: CanvasNodeImage[];
    selectedOutputImageId?: string;
    outputTexts?: CanvasNodeText[];
    selectedOutputTextId?: string;
    outputText?: string;
    outputVideo?: CanvasMediaOutput;
    outputAudio?: CanvasMediaOutput;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasInputRole = "reference" | "composition" | "style" | "palette" | "character" | "material" | "pose" | "depth" | "mask";

export type CanvasGenerationInputRecord = {
    sourceNodeId: string;
    connectionId?: string;
    role: CanvasInputRole;
    instruction?: string;
    reference?: string;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    role?: CanvasInputRole;
    instruction?: string;
    order?: number;
    enabled?: boolean;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
