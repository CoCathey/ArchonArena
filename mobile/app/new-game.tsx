import React, { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View
} from 'react-native';
import {
    DEFAULT_EXPANSIONS,
    EXPANSIONS,
    GAME_FORMATS,
    type GameFormat
} from '../src/game/gameFormats';
import { lobby } from '../src/net/lobbySocket';
import { useAuthStore } from '../src/stores/authStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, ErrorBanner, TextField } from '../src/ui/primitives';

/** One game mode as a tappable tile. */
function FormatTile(props: { format: GameFormat; active: boolean; onPress: () => void }) {
    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.formatTile,
                props.active && styles.formatTileActive,
                pressed && { opacity: 0.75 }
            ]}
            accessibilityRole='radio'
            accessibilityState={{ selected: props.active }}
        >
            <Text style={[styles.formatLabel, props.active && styles.formatLabelActive]}>
                {props.format.label}
            </Text>
            <Text style={styles.formatHint}>{props.format.hint}</Text>
        </Pressable>
    );
}

function ToggleRow(props: {
    label: string;
    hint?: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: spacing.md }}>
                <Text style={styles.toggleLabel}>{props.label}</Text>
                {props.hint ? <Text style={styles.toggleHint}>{props.hint}</Text> : null}
            </View>
            <Switch
                value={props.value}
                onValueChange={props.onChange}
                trackColor={{ true: colors.brandDark, false: colors.surfaceHover }}
                thumbColor={props.value ? colors.brand : colors.textFaint}
            />
        </View>
    );
}

export default function NewGameScreen() {
    const params = useLocalSearchParams<{ quick?: string }>();
    const quickJoin = params.quick === '1';
    const username = useAuthStore((state) => state.user?.username);
    const currentGame = useLobbyStore((state) => state.currentGame);
    const gameError = useLobbyStore((state) => state.gameError);

    const [name, setName] = useState(`${username ?? 'My'}'s game`);
    const [gameFormat, setGameFormat] = useState<GameFormat['name']>('normal');
    const [expansions, setExpansions] = useState<Record<string, boolean>>({
        ...DEFAULT_EXPANSIONS
    });
    const [requirePassword, setRequirePassword] = useState(false);
    const [password, setPassword] = useState('');
    const [allowSpectators, setAllowSpectators] = useState(true);
    const [showHand, setShowHand] = useState(false);
    const [muteSpectators, setMuteSpectators] = useState(false);
    const [hideDeckLists, setHideDeckLists] = useState(false);
    const [gamePrivate, setGamePrivate] = useState(false);
    const [useTimeLimit, setUseTimeLimit] = useState(false);
    const [timeLimit, setTimeLimit] = useState('45');
    const [submitted, setSubmitted] = useState(false);

    // Once the lobby acknowledges the game, replace this modal with the pending
    // screen in a single navigation. (Closing the modal and letting the Play
    // tab open pending separately races two navigations against each other,
    // which cancels out on web.)
    useEffect(() => {
        if (submitted && currentGame) {
            router.replace('/pending');
        }
    }, [submitted, currentGame]);

    const sealed = gameFormat === 'sealed';
    const chosenSets = useMemo(
        () => EXPANSIONS.filter((expansion) => expansions[expansion.name]).length,
        [expansions]
    );
    // A sealed game with no sets has nothing to build a deck from.
    const canCreate = !sealed || chosenSets > 0;

    const setAllExpansions = (value: boolean) =>
        setExpansions(
            Object.fromEntries(EXPANSIONS.map((expansion) => [expansion.name, value]))
        );

    const create = () => {
        const details = {
            name: name.trim() || `${username ?? 'My'}'s game`,
            password: requirePassword ? password : '',
            requirePassword,
            allowSpectators,
            showHand,
            muteSpectators,
            hideDeckLists,
            gamePrivate,
            gameFormat,
            useGameTimeLimit: useTimeLimit,
            gameTimeLimit: Math.max(10, Math.min(120, parseInt(timeLimit, 10) || 45)),
            quickJoin,
            expansions: { ...expansions }
        };
        lobby.newGame(details);
        setSubmitted(true);
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                style={styles.container}
                contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
                keyboardShouldPersistTaps='handled'
                keyboardDismissMode='on-drag'
            >
                <ErrorBanner message={gameError} />

                {!quickJoin ? (
                    <TextField
                        label='Game name'
                        value={name}
                        onChangeText={setName}
                        maxLength={64}
                        autoCapitalize='sentences'
                    />
                ) : (
                    <Text style={styles.quickJoinText}>
                        Quick join finds the first open game in this mode — or creates one if
                        none exists.
                    </Text>
                )}

                <Text style={styles.sectionLabel}>Game mode</Text>
                <View style={styles.formatGrid}>
                    {GAME_FORMATS.map((format) => (
                        <FormatTile
                            key={format.name}
                            format={format}
                            active={format.name === gameFormat}
                            onPress={() => setGameFormat(format.name)}
                        />
                    ))}
                </View>

                {sealed ? (
                    <>
                        <View style={styles.setsHeader}>
                            <Text style={styles.sectionLabel}>Allowed sets</Text>
                            <View style={styles.setsActions}>
                                <Pressable onPress={() => setAllExpansions(true)} hitSlop={8}>
                                    <Text style={styles.setsAction}>All</Text>
                                </Pressable>
                                <Pressable onPress={() => setAllExpansions(false)} hitSlop={8}>
                                    <Text style={styles.setsAction}>None</Text>
                                </Pressable>
                            </View>
                        </View>
                        <Text style={styles.sectionHint}>
                            Sealed decks are drawn from these sets.
                        </Text>
                        <View style={styles.setGrid}>
                            {EXPANSIONS.map((expansion) => {
                                const on = !!expansions[expansion.name];
                                return (
                                    <Pressable
                                        key={expansion.name}
                                        onPress={() =>
                                            setExpansions((previous) => ({
                                                ...previous,
                                                [expansion.name]: !previous[expansion.name]
                                            }))
                                        }
                                        style={({ pressed }) => [
                                            styles.setChip,
                                            on && styles.setChipActive,
                                            pressed && { opacity: 0.75 }
                                        ]}
                                        accessibilityRole='checkbox'
                                        accessibilityState={{ checked: on }}
                                    >
                                        <Text
                                            style={[
                                                styles.setChipText,
                                                on && styles.setChipTextActive
                                            ]}
                                        >
                                            {expansion.label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                        {chosenSets === 0 ? (
                            <Text style={styles.setsWarning}>
                                Pick at least one set to build sealed decks from.
                            </Text>
                        ) : null}
                    </>
                ) : null}

                {!quickJoin ? (
                    <>
                        <View style={{ height: spacing.md }} />
                        <ToggleRow
                            label='Allow spectators'
                            value={allowSpectators}
                            onChange={setAllowSpectators}
                        />
                        {allowSpectators ? (
                            <>
                                <ToggleRow
                                    label='Open hands'
                                    hint='Spectators can see both hands'
                                    value={showHand}
                                    onChange={setShowHand}
                                />
                                <ToggleRow
                                    label='Mute spectators'
                                    value={muteSpectators}
                                    onChange={setMuteSpectators}
                                />
                            </>
                        ) : null}
                        <ToggleRow
                            label='Hide deck lists'
                            value={hideDeckLists}
                            onChange={setHideDeckLists}
                        />
                        <ToggleRow
                            label='Private game'
                            hint='Hidden from the public game list'
                            value={gamePrivate}
                            onChange={setGamePrivate}
                        />
                        <ToggleRow
                            label='Require password'
                            value={requirePassword}
                            onChange={setRequirePassword}
                        />
                        {requirePassword ? (
                            <TextField
                                label='Password'
                                value={password}
                                onChangeText={setPassword}
                                placeholder='Game password'
                            />
                        ) : null}
                        <ToggleRow
                            label='Use time limit'
                            value={useTimeLimit}
                            onChange={setUseTimeLimit}
                        />
                        {useTimeLimit ? (
                            <TextField
                                label='Time limit (minutes)'
                                value={timeLimit}
                                onChangeText={setTimeLimit}
                                keyboardType='number-pad'
                            />
                        ) : null}
                    </>
                ) : null}

                <View style={{ height: spacing.lg }} />
                <Button
                    title={quickJoin ? 'Find a game' : 'Create game'}
                    onPress={create}
                    disabled={!canCreate}
                    loading={submitted && !gameError}
                />
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionLabel: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600',
        marginTop: spacing.md,
        marginBottom: 6
    },
    sectionHint: {
        color: colors.textFaint,
        fontSize: 12,
        marginBottom: spacing.sm
    },
    formatGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    formatTile: {
        // Two per row, accounting for the gap between them.
        width: '48%',
        flexGrow: 1,
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
        gap: 3
    },
    formatTileActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    formatLabel: {
        color: colors.textDim,
        fontSize: 15,
        fontWeight: '800'
    },
    formatLabelActive: {
        color: colors.brand
    },
    formatHint: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 15
    },
    setsHeader: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between'
    },
    setsActions: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingBottom: 6
    },
    setsAction: {
        color: colors.accent,
        fontSize: 12,
        fontWeight: '700'
    },
    setGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6
    },
    setChip: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 12,
        paddingVertical: 7
    },
    setChipActive: {
        backgroundColor: colors.brand,
        borderColor: colors.brand
    },
    setChipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600'
    },
    setChipTextActive: {
        color: '#161006',
        fontWeight: '800'
    },
    setsWarning: {
        color: colors.warning,
        fontSize: 12,
        marginTop: spacing.sm
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10
    },
    toggleLabel: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '600'
    },
    toggleHint: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 2
    },
    quickJoinText: {
        color: colors.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginBottom: spacing.md
    }
});
