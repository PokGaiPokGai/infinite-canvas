import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Square, Video } from "lucide-react";
import { Button, InputNumber, Segmented } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasInputRoleLabel } from "@/lib/canvas/canvas-input-role";
import { getCanvasConfigOutput } from "@/lib/canvas/canvas-config-output";
import { supportsLocalComfyControls } from "./canvas-node-generation";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { useCanvasPopoverAnchor, useCanvasPopoverOutsideClick } from "./use-canvas-popover-anchor";
import type { CanvasGenerationMode, CanvasInputRole, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    inputRoles?: { nodeId: string; role: CanvasInputRole; instruction?: string }[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, inputRoles, onConfigChange, onGenerate, onStop, onComposerToggle }: CanvasConfigNodePanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    const outputImages = (node.metadata?.outputImages || []).filter((image) => image.status === "success" && image.content);
    const selectedOutputId = node.metadata?.selectedOutputImageId;
    const hasUnselectedBatch = outputImages.length > 1 && !outputImages.some((image) => image.id === selectedOutputId);
    const outputTexts = (node.metadata?.outputTexts || []).filter((text) => text.status === "success" && text.content);
    const selectedOutputTextId = node.metadata?.selectedOutputTextId;
    const hasUnselectedTextBatch = (node.metadata?.textCount || 1) > 1 && outputTexts.length > 0 && !outputTexts.some((text) => text.id === selectedOutputTextId);
    const output = getCanvasConfigOutput(node);
    const OutputIcon = mode === "image" ? ImageIcon : mode === "text" ? MessageSquare : mode === "video" ? Video : Music2;
    const needsSelection = mode === "image" ? hasUnselectedBatch : mode === "text" && hasUnselectedTextBatch;
    const outputCount = mode === "image" ? outputImages.length : mode === "text" ? outputTexts.length : 0;
    const hasComfyControls = mode === "image" && supportsLocalComfyControls(globalConfig, config.model);

    return (
        <div className="flex w-full shrink-0 cursor-move flex-col p-3 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 w-full">
                <div className="w-full cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !w-full !rounded-md !p-0.5 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-w-0 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!px-1"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        {t("canvas.configNode.image")}
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        {t("canvas.configNode.text")}
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        {t("canvas.configNode.video")}
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        {t("canvas.configNode.audio")}
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            <div className="mb-2 flex w-full flex-wrap justify-center gap-1.5">
                <InputChip label={t("canvas.configNode.prompt")} value={t("canvas.configNode.items", { count: inputSummary.textCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.references")} value={t("canvas.configNode.images", { count: inputSummary.imageCount })} style={chipStyle} />
                {mode !== "image" ? <InputChip label={t("canvas.configNode.videoReferences")} value={t("canvas.configNode.items", { count: inputSummary.videoCount })} style={chipStyle} /> : null}
                {mode !== "image" ? <InputChip label={t("canvas.configNode.audioReferences")} value={t("canvas.configNode.items", { count: inputSummary.audioCount })} style={chipStyle} /> : null}
            </div>
            <div className="mb-2 flex w-full justify-center">
                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                    <Settings2 className="size-3.5" />
                    {t("canvas.configNode.compose")}
                </button>
            </div>
            <div className="mb-2 flex w-full justify-center">
                <ConfigMiniPopover label={<><OutputIcon className="size-3.5" />{needsSelection ? "请选择本轮输出" : output ? mode === "image" || mode === "text" ? "已选输出" : "输出已就绪" : "输出待生成"}{outputCount > 1 ? ` · ${outputCount} ${mode === "image" ? "张" : "条"}` : ""}</>} width={mode === "image" ? 224 : 288} height={300} chipStyle={chipStyle} textColor={theme.node.text} panelColor={theme.node.panel} strokeColor={theme.node.stroke}>
                    <div className="space-y-2 text-xs">
                    <div>{output ? "当前输出可连接下一步；若下游使用「组装提示词」，请在其中 @ 引用此节点。" : "尚无输出；生成成功后可在此查看或选择。"}</div>
                    {mode === "image" && outputImages.length ? <><div>本轮结果（多图需手动选择）</div><div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">{outputImages.map((image, index) => <button key={image.id} type="button" title={`选择结果 ${index + 1}`} className="relative size-12 overflow-hidden rounded border-2" style={{ borderColor: selectedOutputId === image.id ? theme.node.text : theme.node.stroke }} onClick={(event) => {
                        event.stopPropagation();
                        onConfigChange(node.id, { selectedOutputImageId: image.id, content: image.content, storageKey: image.storageKey, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType });
                    }}><img src={image.content} alt={`结果 ${index + 1}`} className="h-full w-full object-cover" draggable={false} /></button>)}</div></> : null}
                    {mode === "text" && outputTexts.length ? <><div>本轮结果（多条需手动选择）</div><div className="max-h-48 space-y-1.5 overflow-y-auto">{outputTexts.map((text, index) => <button key={text.id} type="button" className="w-full rounded border px-2 py-1.5 text-left" style={{ borderColor: selectedOutputTextId === text.id ? theme.node.text : theme.node.stroke }} onClick={(event) => {
                        event.stopPropagation();
                        onConfigChange(node.id, { selectedOutputTextId: text.id, outputText: text.content });
                    }}><span className="block font-medium">结果 {index + 1}{selectedOutputTextId === text.id ? " · 已选" : ""}</span><span className="block truncate opacity-70">{text.content}</span></button>)}</div></> : null}
                    {mode === "text" && !outputTexts.length && output?.kind === "text" ? <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{output.content}</div> : null}
                    {mode === "video" && output?.kind === "video" ? <video src={output.content} className="max-h-48 w-full rounded" controls preload="metadata" /> : null}
                    {mode === "audio" && output?.kind === "audio" ? <audio src={output.content} className="w-full" controls preload="metadata" /> : null}
                    {needsSelection && output ? <div>当前仍连接上一次选中的结果；本轮结果尚未选择。</div> : null}
                    </div>
                </ConfigMiniPopover>
            </div>
            {hasComfyControls ? <div className="mb-2 flex w-full justify-center"><ComfyControls node={node} onConfigChange={onConfigChange} chipStyle={chipStyle} textColor={theme.node.text} panelColor={theme.node.panel} strokeColor={theme.node.stroke} /></div> : null}

            {mode === "image" && inputRoles?.length ? <div className="mb-2 flex shrink-0 gap-1 overflow-x-auto text-[11px]" title="连线标签表示参考图用途；实际控制能力由所选生成渠道决定。">{inputRoles.map((input, index) => <span key={input.nodeId} className="shrink-0 rounded border px-1.5 py-0.5" style={chipStyle}>图 {index + 1} · {canvasInputRoleLabel(input.role)}{input.instruction ? " · 有说明" : ""}</span>)}</div> : null}

            <div className="mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_148px] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : (
                    <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                )}
            </div>

            <Button
                type="primary"
                className="!h-9 !w-full !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>{t("canvas.configNode.stop")}</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-4" />
                            <span>{t("canvas.configNode.generate")}</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

type ComfyConfig = NonNullable<CanvasNodeMetadata["comfy"]>;

function ConfigMiniPopover({ label, children, width, height, chipStyle, textColor, panelColor, strokeColor }: { label: ReactNode; children: ReactNode; width: number; height: number; chipStyle: CSSProperties; textColor: string; panelColor: string; strokeColor: string }) {
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRect = useCanvasPopoverAnchor(buttonRef, open);
    const wasClosedByTrigger = useCanvasPopoverOutsideClick(buttonRef, panelRef, open, () => setOpen(false));
    const gap = 8;
    const left = buttonRect ? Math.max(gap, Math.min(buttonRect.right + gap + width <= window.innerWidth - gap ? buttonRect.right + gap : buttonRect.left - width - gap, window.innerWidth - width - gap)) : 0;
    const top = buttonRect ? Math.max(gap, Math.min(buttonRect.top, window.innerHeight - height - gap)) : 0;
    return <>
        <button ref={buttonRef} type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} aria-expanded={open} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!wasClosedByTrigger(event)) setOpen((current) => !current); }}>{label}</button>
        {open && buttonRect ? createPortal(<div ref={panelRef} data-canvas-config-mini-popover className="rounded-lg border p-3 text-xs shadow-lg" style={{ position: "fixed", left, top, width, maxHeight: "calc(100vh - 16px)", overflowY: "auto", zIndex: 1200, color: textColor, background: panelColor, borderColor: strokeColor }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>{children}</div>, document.body) : null}
    </>;
}

function ComfyControls({ node, onConfigChange, chipStyle, textColor, panelColor, strokeColor }: { node: CanvasNodeData; onConfigChange: CanvasConfigNodePanelProps["onConfigChange"]; chipStyle: CSSProperties; textColor: string; panelColor: string; strokeColor: string }) {
    const value = node.metadata?.comfy || {};
    const update = (patch: Partial<ComfyConfig>) => onConfigChange(node.id, { comfy: { ...value, ...patch } });
    const number = (label: string, key: "denoise" | "steps" | "cfg" | "seed" | "styleWeight", fallback: number, min?: number, max?: number, step = 1) => <label className="space-y-1"><span>{label}</span><InputNumber className="!w-full" size="small" value={value[key] ?? fallback} min={min} max={max} step={step} precision={key === "steps" || key === "seed" ? 0 : undefined} onChange={(next) => { if (next !== null && Number.isFinite(next)) update({ [key]: next }); }} /></label>;
    const text = (label: string, key: "sampler" | "scheduler", fallback: string) => <label className="space-y-1"><span>{label}</span><input className="w-full rounded border px-2 py-1 text-xs" style={{ borderColor: strokeColor, color: textColor, background: "transparent" }} value={value[key] ?? fallback} onChange={(event) => update({ [key]: event.target.value })} /></label>;
    return <ConfigMiniPopover label={<><Settings2 className="size-3.5" />Comfy 参数</>} width={288} height={410} chipStyle={chipStyle} textColor={textColor} panelColor={panelColor} strokeColor={strokeColor}>
        <div className="space-y-2 text-xs">
        <div className="font-medium">本机 ComfyUI 工作流参数</div>
        <div className="flex flex-wrap gap-1"><button type="button" className="rounded border px-2 py-1" style={{ borderColor: strokeColor }} onClick={() => update({ steps: 6, cfg: 2, denoise: 0.65, sampler: "dpmpp_sde", scheduler: "karras" })}>草稿转绘</button><button type="button" className="rounded border px-2 py-1" style={{ borderColor: strokeColor }} onClick={() => update({ steps: 20, cfg: 7, denoise: 0.35, sampler: "dpmpp_2m", scheduler: "karras" })}>保留结构细化</button><button type="button" className="rounded border px-2 py-1" style={{ borderColor: strokeColor }} onClick={() => onConfigChange(node.id, { comfy: undefined })}>重置默认</button></div>
        <div className="grid grid-cols-2 gap-2">{number("改绘强度", "denoise", 0.65, 0, 1, 0.05)}{number("采样步数", "steps", 6, 1)}{number("CFG", "cfg", 2, 0, undefined, 0.5)}{number("种子（-1 随机）", "seed", -1, -1)}{number("风格权重", "styleWeight", 0.6, 0, 1, 0.05)}{text("采样器", "sampler", "dpmpp_sde")}{text("调度器", "scheduler", "karras")}</div>
        <label className="block space-y-1"><span>负面提示词</span><textarea className="w-full rounded border p-2 text-xs" style={{ borderColor: strokeColor, color: textColor, background: "transparent" }} rows={2} value={value.negativePrompt || ""} onChange={(event) => update({ negativePrompt: event.target.value })} /></label>
        </div>
    </ConfigMiniPopover>;
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
