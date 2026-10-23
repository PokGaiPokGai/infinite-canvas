import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { imageMetadata } from "./canvas-node-factory";
import type { MaskSettings, ProcessResult } from "@/types/canvas-workflow";

export const MASK_EXTRACT = "process:mask-extract";
export const MASK_INVERT = "process:mask-invert";
export const MASK_GROW = "process:mask-grow";
export const MASK_FEATHER = "process:mask-feather";
export const ALPHA_APPLY = "process:alpha-apply";
export const MASK_TYPES = [MASK_EXTRACT, MASK_INVERT, MASK_GROW, MASK_FEATHER, ALPHA_APPLY];
export const maskInputKey = (type: string, settings: MaskSettings | undefined, inputs: { id: string; content?: string; storageKey?: string }[]) => JSON.stringify([type, settings || {}, inputs.map(input => [input.id, input.content ? input.storageKey || input.content : null])]);

async function loadImage(url: string) {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
}

// White means selected/opaque. Masks are stored as opaque grayscale PNGs;
// applying a mask multiplies the source alpha without changing its RGB values.
export async function processMask(type: string, settings: MaskSettings, inputs: ProcessResult[], signal: AbortSignal) {
    signal.throwIfAborted();
    const source = inputs.find(input => input.id === settings.imageId) || (!settings.imageId ? inputs[0] : undefined);
    if (!source || source.kind !== "image" || !source.content) throw new Error("请连接并选择已就绪的图片。");
    if (type !== ALPHA_APPLY && inputs.length !== 1) throw new Error("此蒙版步骤需要一张输入图片。");
    const sourceImage = await loadImage(await imageToDataUrl({ storageKey: source.storageKey, url: source.content }, { signal }));
    const canvas = document.createElement("canvas");
    canvas.width = sourceImage.naturalWidth; canvas.height = sourceImage.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建蒙版画布。");
    context.drawImage(sourceImage, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    if (type === ALPHA_APPLY) {
        const mask = inputs.find(input => input.id === settings.maskId);
        if (!mask || mask.kind !== "image" || mask.id === source.id || !mask.content || inputs.length !== 2) throw new Error("连接两张图片，并分别指定原图与蒙版。");
        const image = await loadImage(await imageToDataUrl({ storageKey: mask.storageKey, url: mask.content }, { signal }));
        if (image.naturalWidth !== canvas.width || image.naturalHeight !== canvas.height) throw new Error("原图与蒙版尺寸必须相同，请先对齐尺寸。");
        context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
        const matte = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i + 3] *= (matte[i] * .2126 + matte[i + 1] * .7152 + matte[i + 2] * .0722) / 255 * matte[i + 3] / 255;
    } else {
        for (let i = 0; i < pixels.data.length; i += 4) {
            const luminance = (pixels.data[i] * .2126 + pixels.data[i + 1] * .7152 + pixels.data[i + 2] * .0722) * pixels.data[i + 3] / 255;
            const value = type === MASK_EXTRACT && settings.channel !== "luminance" ? pixels.data[i + 3] : type === MASK_INVERT ? 255 - luminance : luminance;
            pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
            pixels.data[i + 3] = 255;
        }
    }
    context.putImageData(pixels, 0, 0);
    if (type === MASK_GROW || type === MASK_FEATHER) {
        const radius = type === MASK_GROW ? settings.amount ?? 4 : settings.radius ?? 4;
        if (!Number.isFinite(radius) || (type === MASK_FEATHER && radius < 0)) throw new Error("请输入有效的像素半径；羽化半径不能为负数。");
        // Native SVG morphology/blur supplies the pixel operations, avoiding custom convolution code.
        if (radius) {
            const primitive = type === MASK_GROW ? `<feMorphology operator="${radius > 0 ? "dilate" : "erode"}" radius="${Math.abs(radius)}"/>` : `<feGaussianBlur stdDeviation="${radius}" edgeMode="duplicate"/>`;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}"><defs><filter id="mask" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${primitive}</filter></defs><image width="100%" height="100%" xlink:href="${canvas.toDataURL("image/png")}" filter="url(#mask)"/></svg>`;
            const filtered = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
            context.fillStyle = "#000000"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(filtered, 0, 0);
        }
    }
    signal.throwIfAborted();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("蒙版编码失败。")), "image/png"));
    return { ...imageMetadata(await uploadImage(blob, { signal })), outputKind: "image" as const, status: "success" as const };
}
