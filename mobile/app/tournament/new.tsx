import React, { useState } from 'react';
import { router, Stack } from 'expo-router';
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
import { createTournament } from '../../src/api/tournaments';
import { GAME_FORMATS } from '../../src/game/gameFormats';
import { useAuthStore } from '../../src/stores/authStore';
import { colors, radius, spacing } from '../../src/theme';
import { Button, ErrorBanner, TextField } from '../../src/ui/primitives';

/** Pairing structures the engine can run. */
const FORMATS = [
    { key: 'swiss', label: 'Swiss', hint: 'Everyone plays every round.' },
    { key: 'single-elim', label: 'Single elim', hint: 'Lose once and you are out.' },
    { key: 'double-elim', label: 'Double elim', hint: 'A losers bracket runs alongside.' },
    { key: 'round-robin', label: 'Round robin', hint: 'Everyone plays everyone.' }
] as const;

/** Live events run to a clock; async ones run to a per-round deadline. */
const PACING = [
    { key: 'live', label: 'Live', hint: 'Played in one sitting, round by round.' },
    { key: 'async', label: 'Async', hint: 'Players arrange their own match times.' }
] as const;

function Choice<T extends string>(props: {
    options: readonly { key: T; label: string; hint?: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <View style={styles.choiceGrid}>
            {props.options.map((option) => (
                <Pressable
                    key={option.key}
                    onPress={() => props.onChange(option.key)}
                    style={({ pressed }) => [
                        styles.choice,
                        props.value === option.key && styles.choiceActive,
                        pressed && { opacity: 0.75 }
                    ]}
                >
                    <Text
                        style={[
                            styles.choiceLabel,
                            props.value === option.key && { color: colors.brand }
                        ]}
                    >
                        {option.label}
                    </Text>
                    {option.hint ? <Text style={styles.choiceHint}>{option.hint}</Text> : null}
                </Pressable>
            ))}
        </View>
    );
}

function Toggle(props: {
    label: string;
    hint?: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: spacing.md }}>
                <Text style={styles.toggleLabel}>{props.label}</Text>
                {props.hint ? <Text style={styles.choiceHint}>{props.hint}</Text> : null}
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

export default function NewTournamentScreen() {
    const username = useAuthStore((state) => state.user?.username);

    const [name, setName] = useState(`${username ?? 'My'}'s event`);
    const [description, setDescription] = useState('');
    const [format, setFormat] = useState<(typeof FORMATS)[number]['key']>('swiss');
    const [gameFormat, setGameFormat] = useState('normal');
    const [pacing, setPacing] = useState<(typeof PACING)[number]['key']>('live');
    const [roundCount, setRoundCount] = useState('4');
    const [bestOf, setBestOf] = useState('1');
    const [playerCap, setPlayerCap] = useState('');
    const [roundDeadlineDays, setRoundDeadlineDays] = useState('3');
    const [privateEvent, setPrivateEvent] = useState(false);
    const [rated, setRated] = useState(true);
    const [requireDeck, setRequireDeck] = useState(false);
    const [sasBound, setSasBound] = useState(false);
    const [sasMin, setSasMin] = useState('60');
    const [sasMax, setSasMax] = useState('80');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const create = async () => {
        setBusy(true);
        setError(undefined);
        try {
            const details: Record<string, unknown> = {
                name: name.trim() || `${username ?? 'My'}'s event`,
                description: description.trim() || undefined,
                format,
                gameFormat,
                pacing,
                roundCount: parseInt(roundCount, 10) || undefined,
                bestOf: parseInt(bestOf, 10) || 1,
                playerCap: playerCap ? parseInt(playerCap, 10) : undefined,
                visibility: privateEvent ? 'private' : 'public',
                ratedGames: rated,
                requireDeckRegistration: requireDeck
            };

            if (pacing === 'async') {
                details.roundDeadlineDays = parseInt(roundDeadlineDays, 10) || 3;
            }

            if (sasBound) {
                const min = parseInt(sasMin, 10);
                const max = parseInt(sasMax, 10);
                if (Number.isFinite(min) && Number.isFinite(max)) {
                    details.sasMin = Math.min(min, max);
                    details.sasMax = Math.max(min, max);
                }
            }

            const result = await createTournament(details);
            if (!result.success) {
                setError(result.message ?? 'Could not create this event');
                return;
            }

            const id = result.tournamentId ?? result.id;
            // Straight into the event just created, rather than back to a list
            // the organizer then has to search.
            if (id) {
                router.replace(`/tournament/${id}`);
            } else {
                router.back();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create this event');
        } finally {
            setBusy(false);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <Stack.Screen options={{ title: 'New event' }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.lg, paddingBottom: 56 }}
                keyboardShouldPersistTaps='handled'
                keyboardDismissMode='on-drag'
            >
                <ErrorBanner message={error} />

                <TextField
                    label='Event name'
                    value={name}
                    onChangeText={setName}
                    maxLength={80}
                    autoCapitalize='sentences'
                />
                <TextField
                    label='Description'
                    value={description}
                    onChangeText={setDescription}
                    placeholder='Anything players should know'
                    multiline
                    autoCapitalize='sentences'
                    style={{ minHeight: 72, textAlignVertical: 'top' }}
                />

                <Text style={styles.sectionLabel}>Structure</Text>
                <Choice options={FORMATS} value={format} onChange={setFormat} />

                <Text style={styles.sectionLabel}>Pacing</Text>
                <Choice options={PACING} value={pacing} onChange={setPacing} />

                <Text style={styles.sectionLabel}>Game mode</Text>
                <Choice
                    options={GAME_FORMATS.map((entry) => ({
                        key: entry.name,
                        label: entry.label
                    }))}
                    value={gameFormat}
                    onChange={setGameFormat}
                />

                <View style={styles.numberRow}>
                    <TextField
                        label='Rounds'
                        value={roundCount}
                        onChangeText={setRoundCount}
                        keyboardType='number-pad'
                        containerStyle={{ flex: 1, marginBottom: 0 }}
                    />
                    <TextField
                        label='Best of'
                        value={bestOf}
                        onChangeText={setBestOf}
                        keyboardType='number-pad'
                        containerStyle={{ flex: 1, marginBottom: 0 }}
                    />
                    <TextField
                        label='Player cap'
                        value={playerCap}
                        onChangeText={setPlayerCap}
                        placeholder='none'
                        keyboardType='number-pad'
                        containerStyle={{ flex: 1, marginBottom: 0 }}
                    />
                </View>

                {pacing === 'async' ? (
                    <TextField
                        label='Days per round'
                        value={roundDeadlineDays}
                        onChangeText={setRoundDeadlineDays}
                        keyboardType='number-pad'
                        containerStyle={{ marginTop: spacing.md }}
                    />
                ) : null}

                <Text style={styles.sectionLabel}>Rules</Text>
                <Toggle
                    label='Rated'
                    hint='Results move the ladder.'
                    value={rated}
                    onChange={setRated}
                />
                <Toggle
                    label='Register a deck'
                    hint='Players lock a deck in before the event starts.'
                    value={requireDeck}
                    onChange={setRequireDeck}
                />
                <Toggle
                    label='SAS bound'
                    hint='Only decks inside the range may be played.'
                    value={sasBound}
                    onChange={setSasBound}
                />
                {sasBound ? (
                    <View style={styles.numberRow}>
                        <TextField
                            label='Min SAS'
                            value={sasMin}
                            onChangeText={setSasMin}
                            keyboardType='number-pad'
                            containerStyle={{ flex: 1, marginBottom: 0 }}
                        />
                        <TextField
                            label='Max SAS'
                            value={sasMax}
                            onChangeText={setSasMax}
                            keyboardType='number-pad'
                            containerStyle={{ flex: 1, marginBottom: 0 }}
                        />
                    </View>
                ) : null}
                <Toggle
                    label='Private'
                    hint='Hidden from the list; players need the join code.'
                    value={privateEvent}
                    onChange={setPrivateEvent}
                />

                <View style={{ height: spacing.lg }} />
                <Button title='Create event' onPress={create} loading={busy} />
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    sectionLabel: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '700',
        marginTop: spacing.lg,
        marginBottom: spacing.sm
    },
    choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    choice: {
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
    choiceActive: { borderColor: colors.brand, backgroundColor: colors.surfaceHover },
    choiceLabel: { color: colors.textDim, fontSize: 14, fontWeight: '800' },
    choiceHint: { color: colors.textFaint, fontSize: 11, lineHeight: 15 },
    numberRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
    toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    toggleLabel: { color: colors.text, fontSize: 15, fontWeight: '600' }
});
