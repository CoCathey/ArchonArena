import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PluginEntry = string | [string, Record<string, unknown>?];

const app = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
    expo: { plugins: PluginEntry[] };
};

function pluginOptions(name: string): Record<string, unknown> | undefined {
    const entry = app.expo.plugins.find((plugin) =>
        Array.isArray(plugin) ? plugin[0] === name : plugin === name
    );
    return Array.isArray(entry) ? entry[1] : undefined;
}

// Several Expo plugins own the same Info.plist permission keys, and each one
// DELETES a key it is told is `false`. The QR check-in scanner needs
// NSCameraUsageDescription from expo-camera; an expo-image-picker entry of
// `cameraPermission: false` removed it again from the built app, and opening
// the scanner then died with "This app is missing NSCameraUsageDescription".
describe('app.json permission strings', () => {
    it('gives every plugin that touches the camera the same usage description', () => {
        const camera = pluginOptions('expo-camera')?.cameraPermission;
        expect(typeof camera).toBe('string');
        expect(String(camera).length).toBeGreaterThan(20);

        for (const plugin of app.expo.plugins) {
            if (!Array.isArray(plugin) || !plugin[1] || !('cameraPermission' in plugin[1])) {
                continue;
            }
            expect(plugin[1].cameraPermission, `${plugin[0]} cameraPermission`).toBe(camera);
        }
    });

    it('never disables a permission another plugin depends on', () => {
        const disabled = app.expo.plugins.flatMap((plugin) =>
            Array.isArray(plugin) && plugin[1]
                ? Object.entries(plugin[1])
                      .filter(([key, value]) => key.endsWith('Permission') && value === false)
                      .map(([key]) => `${plugin[0]}.${key}`)
                : []
        );
        // Microphone is genuinely unused everywhere, so both plugins may say so;
        // nothing else may be switched off.
        expect(disabled.filter((entry) => !entry.endsWith('microphonePermission'))).toEqual([]);
    });
});
