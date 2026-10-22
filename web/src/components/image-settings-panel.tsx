import { type ReactNode, useEffect, useState } from "react";
import { ConfigProvider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, readMediaDimensions } from "@/lib/media-size";
import type { AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", labelKey: "auto" },
    { value: "low", labelKey: "low" },
    { value: "medium", labelKey: "medium" },
    { value: "high", labelKey: "high" },
    { value: "xhigh", labelKey: "xhigh" },
    { value: "max", labelKey: "max" },
];
const DIMENSION_STEP = 16;

export const imageQualityOptions = qualityOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.labelKey}`); } }));
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count" | "background", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15 }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => applySize(scale, selectedRatio === "auto" ? "1:1" : selectedRatio);
    const selectRatio = (ratio: string) => applySize(selectedScale, ratio);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-sm font-semibold">{t("settingsPanels.image.title")}</div> : null}
                <QualityControl value={quality} theme={theme} onChange={(value) => onConfigChange("quality", value)} />
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                {t("settingsPanels.image.align16")}
                            </span>
                            <span title={t("settingsPanels.image.align16Hint")} onMouseDown={(event) => event.stopPropagation()}>
                                <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                            </span>
                        </div>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaScaleOptions.map((value) => (
                            <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                {value === "auto" ? t("settingsPanels.common.auto") : value}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectRatio(item.value)}
                            >
                                <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                        <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                            {t("settingsPanels.image.transparentHint")}
                        </div>
                    </div>
                    <span onMouseDown={(event) => event.stopPropagation()}>
                        <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                    </span>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                    <CountInput value={count} max={maxCount} theme={theme} label={t("settingsPanels.image.count")} onChange={(value) => onConfigChange("count", String(value))} />
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: {
                    Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text },
                    Slider: { railBg: theme.node.stroke, railHoverBg: theme.node.stroke, trackBg: theme.node.activeStroke, handleColor: theme.node.text, handleActiveColor: theme.node.text },
                },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return qualityOptions.some((item) => item.value === value) ? i18n.t(`settingsPanels.common.${value}`) : value;
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function QualityControl({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    const index = Math.max(0, qualityOptions.findIndex((item) => item.value === value));
    const progress = index / (qualityOptions.length - 1);
    const thumbPosition = `calc(${progress * 100}% + ${14 - progress * 28}px)`;
    const accent = index === 0 ? theme.node.muted : index === qualityOptions.length - 1 ? theme === canvasThemes.dark ? "#c084fc" : "#7e22ce" : theme === canvasThemes.dark ? "#60a5fa" : "#1d4ed8";
    return (
        <div className="rounded-2xl border px-3 pb-3 pt-2.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
            <div className="text-center text-xs font-semibold transition-colors duration-200 motion-reduce:transition-none" style={{ color: accent }}>{t(`settingsPanels.common.${qualityOptions[index].labelKey}`)}</div>
            <div className="text-center text-[11px] leading-4" style={{ color: theme.node.muted }}>{t("settingsPanels.image.quality")}</div>
            <div className="relative mt-2 h-7 rounded-full focus-within:ring-2 focus-within:ring-blue-500/60">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                    <div className="absolute inset-y-0 left-0 rounded-full bg-[#3b82f6] transition-[width,opacity] duration-[260ms] ease-out motion-reduce:transition-none" style={{ width: thumbPosition, opacity: index > 0 ? 1 : 0 }} />
                    <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#3b82f6] via-[#7478fb] to-[#b46af5] transition-[width,opacity] duration-[260ms] ease-out motion-reduce:transition-none" style={{ width: thumbPosition, opacity: index === qualityOptions.length - 1 ? 1 : 0 }} />
                    <div className="absolute inset-0 flex items-center justify-between px-3.5">
                        {qualityOptions.map((item, step) => <span key={item.value} className="size-1 rounded-full" style={{ background: step <= index && index > 0 ? "rgba(255,255,255,.6)" : theme.node.muted, opacity: 0.65 }} />)}
                    </div>
                </div>
                <span className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md transition-[left] duration-[260ms] ease-out motion-reduce:transition-none" style={{ left: thumbPosition, background: theme.node.text }} />
                <input type="range" min={0} max={qualityOptions.length - 1} step={1} value={index} aria-label={t("settingsPanels.image.quality")} aria-valuetext={t(`settingsPanels.common.${qualityOptions[index].labelKey}`)} className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent opacity-0 [&::-webkit-slider-runnable-track]:h-7 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:size-7 [&::-webkit-slider-thumb]:appearance-none [&::-moz-range-track]:h-7 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-7 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0" onChange={(event) => onChange(qualityOptions[Number(event.currentTarget.value)].value)} />
            </div>
        </div>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, label, onChange }: { value: number; max: number; theme: CanvasTheme; label: string; onChange: (value: number) => void }) {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    const parsed = Number(draft);
    const current = draft.trim() && Number.isFinite(parsed) ? Math.floor(parsed) : value;
    const commit = (next: number) => {
        const clamped = Math.max(1, Math.min(max, Math.floor(next)));
        setDraft(String(clamped));
        if (clamped !== value) onChange(clamped);
    };

    return (
        <div className="flex h-9 w-full items-center overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <button type="button" aria-label={`${label} -1`} disabled={current <= 1} className="grid h-full w-10 shrink-0 place-items-center bg-transparent text-lg transition hover:opacity-60 disabled:opacity-30" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={() => commit(current - 1)}>−</button>
            <input
                type="number"
                min={1}
                max={max}
                step={1}
                aria-label={label}
                className="h-full min-w-0 flex-1 border-x bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commit(current)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <button type="button" aria-label={`${label} +1`} disabled={current >= max} className="grid h-full w-10 shrink-0 place-items-center bg-transparent text-lg transition hover:opacity-60 disabled:opacity-30" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={() => commit(current + 1)}>+</button>
        </div>
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
