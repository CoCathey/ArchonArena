import * as Haptics from 'expo-haptics';

/**
 * Thin, fire-and-forget haptics helpers. Every call is best-effort: haptics
 * are unsupported on some devices/simulators and must never throw into the UI.
 */

export function tapFeedback(): void {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function selectionFeedback(): void {
    Haptics.selectionAsync().catch(() => {});
}

export function successFeedback(): void {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function warnFeedback(): void {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}
