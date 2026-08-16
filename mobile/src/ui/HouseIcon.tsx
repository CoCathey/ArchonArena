import React from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { houseKey } from './houseNames';

const HOUSE_ICONS: Record<string, number> = {
    brobnar: require('../../assets/img/houses/brobnar.png'),
    dis: require('../../assets/img/houses/dis.png'),
    ekwidon: require('../../assets/img/houses/ekwidon.png'),
    geistoid: require('../../assets/img/houses/geistoid.png'),
    logos: require('../../assets/img/houses/logos.png'),
    mars: require('../../assets/img/houses/mars.png'),
    ouboros: require('../../assets/img/houses/ouboros.png'),
    redemption: require('../../assets/img/houses/redemption.png'),
    sanctum: require('../../assets/img/houses/sanctum.png'),
    saurian: require('../../assets/img/houses/saurian.png'),
    shadows: require('../../assets/img/houses/shadows.png'),
    skyborn: require('../../assets/img/houses/skyborn.png'),
    staralliance: require('../../assets/img/houses/staralliance.png'),
    unfathomable: require('../../assets/img/houses/unfathomable.png'),
    untamed: require('../../assets/img/houses/untamed.png')
};

/** Every house, in the order the card sets introduced them. */
export const HOUSES: string[] = Object.keys(HOUSE_ICONS);

// The naming lives in houseNames.ts, which imports nothing native, so a module
// that only needs to name a house can do it without pulling in a component.
// Re-exported here because this is where everything already imports it from.
export { houseLabel } from './houseNames';

export function houseIconSource(house?: string): number | undefined {
    if (!house) {
        return undefined;
    }
    return HOUSE_ICONS[houseKey(house)];
}

export default function HouseIcon(props: {
    house?: string;
    size?: number;
    active?: boolean;
    dimmed?: boolean;
}) {
    const size = props.size ?? 28;
    const source = houseIconSource(props.house);
    if (!source) {
        return <View style={{ width: size, height: size }} />;
    }
    return (
        <View
            style={[
                { width: size, height: size },
                props.active && [styles.active, { borderRadius: size / 2 }],
                props.dimmed && { opacity: 0.35 }
            ]}
        >
            <Image
                source={source}
                style={{ width: size, height: size }}
                contentFit='contain'
                transition={60}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    active: {
        shadowColor: colors.brand,
        shadowOpacity: 0.9,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
        elevation: 6
    }
});
