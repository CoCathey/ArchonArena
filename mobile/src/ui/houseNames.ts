/**
 * House display names, with nothing native in the module.
 *
 * Split out of `HouseIcon` so code that only needs to name a house does not
 * have to import a component — which pulls in `react-native` and `expo-image`,
 * and makes the importing module untestable under the node-environment test
 * runner this project uses. `HouseIcon` re-exports these, so every existing
 * import keeps working.
 */

/** Codes whose display name is not just the capitalised code. */
const HOUSE_LABELS: Record<string, string> = {
    staralliance: 'Star Alliance'
};

/** Normalised lookup key for a house code. */
export function houseKey(house: string): string {
    return house.toLowerCase().replace(/\s+/g, '');
}

/** Display name for a house code ('staralliance' -> 'Star Alliance'). */
export function houseLabel(house: string): string {
    return HOUSE_LABELS[houseKey(house)] ?? house.charAt(0).toUpperCase() + house.slice(1);
}
