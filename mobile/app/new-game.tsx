import React, { useEffect, useState } from 'react';
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
import { lobby } from '../src/net/lobbySocket';
import { useAuthStore } from '../src/stores/authStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, ErrorBanner, TextField } from '../src/ui/primitives';

// Unchained and Reversal are hidden from the UI for now (the engine still
// supports them), matching the web client's format list.
const GAME_FORMATS = [{ name: 'normal', label: 'Archon' }] as const;

/** Expansion flags the web client submits; only used by sealed formats. */
const DEFAULT_EXPANSIONS: Record<string, boolean> = {
    aoa: false,
    as: false,
    cc: false,
    cota: false,
    dm: false,
    disc: false,
    dt: false,
    gr: false,
    mm: false,
    momu: false,
    pv: true,
    toc: false,
    vm2023: false,
    vm2024: false,
    vm2025: false,
    vm2026: false,
    wc: false,
    woe: false
};

function Segmented<T extends string>(props: {
    options: readonly { name: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <View style={styles.segmented}>
            {props.options.map((option) => {
                const active = option.name === props.value;
                return (
                    <Pressable
                        key={option.name}
                        onPress={() => props.onChange(option.name)}
                        style={[styles.segment, active && styles.segmentActive]}
                    >
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
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
    const [gameFormat, setGameFormat] =
        useState<(typeof GAME_FORMATS)[number]['name']>('normal');
    const [requirePassword, setRequirePassword] = useState(false);
    const [password, setPassword] = useState('');
    const [allowSpectators, setAllowSpectators] = useState(true);
    const [showHand, setShowHand] = useState(false);
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

    const create = () => {
        const details = {
            name: name.trim() || `${username ?? 'My'}'s game`,
            password: requirePassword ? password : '',
            requirePassword,
            allowSpectators,
            showHand,
            gamePrivate,
            gameFormat,
            useGameTimeLimit: useTimeLimit,
            gameTimeLimit: Math.max(10, Math.min(120, parseInt(timeLimit, 10) || 45)),
            quickJoin,
            expansions: { ...DEFAULT_EXPANSIONS }
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
                contentContainerStyle={{ padding: spacing.lg }}
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
                    Quick join finds the first open game matching your settings — or creates one
                    if none exists.
                </Text>
            )}

            {/* Only worth a picker once more than one format is offered. */}
            {GAME_FORMATS.length > 1 ? (
                <>
                    <Text style={styles.sectionLabel}>Format</Text>
                    <Segmented
                        options={GAME_FORMATS}
                        value={gameFormat}
                        onChange={setGameFormat}
                    />
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
                    <ToggleRow
                        label='Open hands'
                        hint='Both players can see each other’s hands'
                        value={showHand}
                        onChange={setShowHand}
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
    segmented: {
        flexDirection: 'row',
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden'
    },
    segment: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 10
    },
    segmentActive: {
        backgroundColor: colors.brand
    },
    segmentText: {
        color: colors.textDim,
        fontSize: 14,
        fontWeight: '600'
    },
    segmentTextActive: {
        color: '#161006'
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
