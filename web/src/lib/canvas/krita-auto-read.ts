export const DEFAULT_KRITA_AUTO_READ_DELAY_SECONDS = 2;

export const kritaAutoReadDelay = (seconds?: number) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_KRITA_AUTO_READ_DELAY_SECONDS;
