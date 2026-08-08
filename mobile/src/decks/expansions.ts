/**
 * Set labels, mirroring client/constants.js Expansions. The API returns the
 * numeric expansion id; players know their decks by the set's short name.
 */
const EXPANSION_LABELS: Record<string, string> = {
    '341': 'CotA',
    '435': 'AoA',
    '452': 'WC',
    '479': 'MM',
    '496': 'DT',
    '600': 'WoE',
    '601': 'UC2022',
    '609': 'VM2023',
    '700': 'GR',
    '737': 'VM2024',
    '800': 'AS',
    '855': 'ToC',
    '874': 'MoMu',
    '886': 'PV',
    '907': 'DISC',
    '918': 'CC',
    '928': 'DM',
    '939': 'VM2025',
    '964': 'VM2026'
};

export function expansionLabel(expansion?: number | string): string | undefined {
    if (expansion === undefined || expansion === null) {
        return undefined;
    }
    return EXPANSION_LABELS[String(expansion)];
}
