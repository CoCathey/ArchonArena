import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    checkIn,
    cutToPlayoff,
    dropFromTournament,
    fetchTournament,
    finishTournament,
    nextRound,
    openCheckIn,
    registerForTournament,
    registerTournamentDeck,
    resolveUnfinished,
    startTournament,
    type StandingRow,
    type TournamentDetail,
    type TournamentMatch,
    type TournamentPlayer
} from '../../src/api/tournaments';
import DeckPreview from '../../src/decks/DeckPreview';
import DeckRow from '../../src/decks/DeckRow';
import { useDeckLibrary } from '../../src/decks/useDeckLibrary';
import MyMatchCard from '../../src/tournaments/MyMatchCard';
import { localTime, relativeTime, statusLabel, tournamentFormatLabel } from '../../src/tournaments/format';
import { useAuthStore } from '../../src/stores/authStore';
import { colors, radius, spacing } from '../../src/theme';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../../src/ui/primitives';

const SECTIONS = [
    { key: 'info', label: 'Info' },
    { key: 'players', label: 'Players' },
    { key: 'rounds', label: 'Rounds' },
    { key: 'standings', label: 'Standings' }
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

function Row(props: { label: string; value?: string | null }) {
    if (!props.value) {
        return null;
    }
    return (
        <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{props.label}</Text>
            <Text style={styles.infoValue}>{props.value}</Text>
        </View>
    );
}

function MatchLine(props: { match: TournamentMatch; myUserId?: number }) {
    const { match } = props;
    const mine = match.player1Id === props.myUserId || match.player2Id === props.myUserId;
    const decided = !!match.winnerId;

    return (
        <View style={[styles.matchLine, mine && styles.matchLineMine]}>
            <Text style={styles.matchTable}>{match.table ? `T${match.table}` : '–'}</Text>
            <Text style={styles.matchNames} numberOfLines={1}>
                {match.player1 ?? 'bye'}
                {match.player2 ? ` vs ${match.player2}` : ''}
            </Text>
            <Text style={[styles.matchResult, decided && { color: colors.text }]}>
                {decided
                    ? `${match.player1Wins ?? 0}–${match.player2Wins ?? 0}${
                          match.confirmed ? '' : '?'
                      }`
                    : match.scheduledAt
                    ? (localTime(match.scheduledAt) ?? '')
                    : 'open'}
            </Text>
        </View>
    );
}

export default function TournamentDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const tournamentId = parseInt(String(id), 10);
    const myUserId = useAuthStore((state) => state.user?.id);
    const myNumericId = typeof myUserId === 'string' ? parseInt(myUserId, 10) : myUserId;

    const [tournament, setTournament] = useState<TournamentDetail | undefined>();
    const [players, setPlayers] = useState<TournamentPlayer[]>([]);
    const [matches, setMatches] = useState<TournamentMatch[]>([]);
    const [standings, setStandings] = useState<StandingRow[]>([]);
    const [section, setSection] = useState<SectionKey>('info');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [joinCode, setJoinCode] = useState('');
    const [deckPicker, setDeckPicker] = useState(false);
    const [previewDeck, setPreviewDeck] = useState<Parameters<typeof DeckPreview>[0]['deck']>();

    const library = useDeckLibrary({
        pageSize: 30,
        enabled: deckPicker,
        sasMin: tournament?.sasMin ?? undefined,
        sasMax: tournament?.sasMax ?? undefined
    });

    const load = useCallback(async () => {
        if (!Number.isFinite(tournamentId)) {
            return;
        }
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchTournament(tournamentId);
            if (!result.success || !result.tournament) {
                setError(result.message ?? 'Could not load this event');
                return;
            }
            setTournament(result.tournament);
            setPlayers(result.players ?? []);
            setMatches(result.matches ?? []);
            setStandings(result.standings ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load this event');
        } finally {
            setLoading(false);
        }
    }, [tournamentId]);

    useEffect(() => {
        load();
    }, [load]);

    const run = async (
        key: string,
        action: () => Promise<{ success: boolean; message?: string }>
    ) => {
        setBusy(key);
        setError(undefined);
        try {
            const result = await action();
            if (!result.success) {
                setError(result.message ?? 'That did not work.');
                return;
            }
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That did not work.');
        } finally {
            setBusy(undefined);
        }
    };

    /** The caller's live match in the current round, if they have one. */
    const myMatch = useMemo(() => {
        if (!tournament || !myNumericId || tournament.status !== 'active') {
            return undefined;
        }
        return matches.find(
            (match) =>
                match.round === tournament.currentRound &&
                (match.player1Id === myNumericId || match.player2Id === myNumericId)
        );
    }, [matches, myNumericId, tournament]);

    const rounds = useMemo(() => {
        const byRound = new Map<number, TournamentMatch[]>();
        for (const match of matches) {
            const list = byRound.get(match.round) ?? [];
            list.push(match);
            byRound.set(match.round, list);
        }
        return [...byRound.entries()].sort((a, b) => b[0] - a[0]);
    }, [matches]);

    if (!tournament) {
        return (
            <View style={styles.container}>
                <Stack.Screen options={{ title: 'Event' }} />
                <View style={{ padding: spacing.md }}>
                    <ErrorBanner message={error} />
                </View>
                {loading ? <ActivityIndicator color={colors.brand} /> : null}
            </View>
        );
    }

    const canManage = !!tournament.canManage;
    const deadline = relativeTime(tournament.roundEndsAt);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: tournament.name }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 56 }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={load}
                        tintColor={colors.textDim}
                    />
                }
            >
                <ErrorBanner message={error} />

                <Text style={styles.name}>{tournament.name}</Text>
                <Text style={styles.subtitle}>
                    {tournamentFormatLabel(tournament.format)} · {statusLabel(tournament)}
                    {tournament.pacing === 'async' ? ' · async' : ''}
                </Text>
                {tournament.announcement ? (
                    <Text style={styles.announcement}>{tournament.announcement}</Text>
                ) : null}
                {deadline && tournament.status === 'active' ? (
                    <Text style={styles.deadline}>Round ends {deadline}</Text>
                ) : null}

                {/* ---- What this player does next ---- */}
                {myMatch ? (
                    <MyMatchCard
                        tournament={tournament}
                        match={myMatch}
                        myUserId={myNumericId as number}
                        onChanged={load}
                    />
                ) : null}

                {/* ---- Joining ---- */}
                {tournament.status === 'registration' && !tournament.isRegistered ? (
                    <Card style={{ marginBottom: spacing.md }}>
                        <Text style={styles.cardTitle}>Enter this event</Text>
                        {tournament.visibility === 'private' ? (
                            <TextField
                                placeholder='Join code'
                                value={joinCode}
                                onChangeText={setJoinCode}
                                autoCapitalize='characters'
                            />
                        ) : null}
                        <Button
                            title='Register'
                            loading={busy === 'register'}
                            onPress={() =>
                                run('register', () =>
                                    registerForTournament(tournament.id, {
                                        joinCode: joinCode.trim() || undefined
                                    })
                                )
                            }
                        />
                    </Card>
                ) : null}

                {tournament.isRegistered ? (
                    <Card style={{ marginBottom: spacing.md }}>
                        <Text style={styles.cardTitle}>
                            {tournament.isWaitlisted ? 'You are on the waitlist' : 'You are in'}
                        </Text>
                        {tournament.requireDeckRegistration ? (
                            <Text style={styles.cardBody}>
                                {tournament.myDeckId
                                    ? 'Deck registered.'
                                    : 'This event needs a registered deck.'}
                            </Text>
                        ) : null}
                        <View style={styles.actions}>
                            {tournament.checkInOpen && !tournament.isCheckedIn ? (
                                <Button
                                    small
                                    title='Check in'
                                    loading={busy === 'checkin'}
                                    onPress={() => run('checkin', () => checkIn(tournament.id))}
                                />
                            ) : null}
                            {tournament.isCheckedIn ? (
                                <Text style={styles.checkedIn}>✓ Checked in</Text>
                            ) : null}
                            {tournament.canSwapDeck || !tournament.myDeckId ? (
                                <Button
                                    small
                                    variant='secondary'
                                    title={tournament.myDeckId ? 'Change deck' : 'Choose deck'}
                                    onPress={() => setDeckPicker(true)}
                                />
                            ) : null}
                            <Button
                                small
                                variant='ghost'
                                title='Drop'
                                loading={busy === 'drop'}
                                onPress={() =>
                                    Alert.alert('Drop out', `Leave ${tournament.name}?`, [
                                        { text: 'Stay', style: 'cancel' },
                                        {
                                            text: 'Drop',
                                            style: 'destructive',
                                            onPress: () =>
                                                run('drop', () =>
                                                    dropFromTournament(tournament.id)
                                                )
                                        }
                                    ])
                                }
                            />
                        </View>
                    </Card>
                ) : null}

                {/* ---- Organizer ---- */}
                {canManage ? (
                    <Card style={{ marginBottom: spacing.md }}>
                        <Text style={styles.cardTitle}>Run the event</Text>
                        {tournament.checkInCode ? (
                            <Text style={styles.cardBody}>
                                Check-in code: {tournament.checkInCode}
                            </Text>
                        ) : null}
                        {tournament.joinCode ? (
                            <Text style={styles.cardBody}>Join code: {tournament.joinCode}</Text>
                        ) : null}
                        <View style={styles.actions}>
                            {tournament.status === 'registration' ? (
                                <>
                                    {!tournament.checkInOpen ? (
                                        <Button
                                            small
                                            variant='secondary'
                                            title='Open check-in'
                                            loading={busy === 'open'}
                                            onPress={() =>
                                                run('open', () => openCheckIn(tournament.id))
                                            }
                                        />
                                    ) : null}
                                    <Button
                                        small
                                        title='Start'
                                        loading={busy === 'start'}
                                        onPress={() =>
                                            Alert.alert(
                                                'Start the event',
                                                'Pair round one now?',
                                                [
                                                    { text: 'Not yet', style: 'cancel' },
                                                    {
                                                        text: 'Start',
                                                        onPress: () =>
                                                            run('start', () =>
                                                                startTournament(tournament.id)
                                                            )
                                                    },
                                                    {
                                                        text: 'Start, drop no-shows',
                                                        onPress: () =>
                                                            run('start', () =>
                                                                startTournament(
                                                                    tournament.id,
                                                                    true
                                                                )
                                                            )
                                                    }
                                                ]
                                            )
                                        }
                                    />
                                </>
                            ) : null}
                            {tournament.status === 'active' ? (
                                <>
                                    <Button
                                        small
                                        title='Next round'
                                        loading={busy === 'next'}
                                        onPress={() => run('next', () => nextRound(tournament.id))}
                                    />
                                    {tournament.cutTo ? (
                                        <Button
                                            small
                                            variant='secondary'
                                            title='Cut to playoff'
                                            loading={busy === 'cut'}
                                            onPress={() =>
                                                run('cut', () => cutToPlayoff(tournament.id))
                                            }
                                        />
                                    ) : null}
                                    <Button
                                        small
                                        variant='secondary'
                                        title='Time in the round'
                                        loading={busy === 'resolve'}
                                        onPress={() =>
                                            Alert.alert(
                                                'Time in the round',
                                                'Decide every match still open?',
                                                [
                                                    { text: 'Cancel', style: 'cancel' },
                                                    {
                                                        text: 'Resolve',
                                                        style: 'destructive',
                                                        onPress: () =>
                                                            run('resolve', () =>
                                                                resolveUnfinished(tournament.id)
                                                            )
                                                    }
                                                ]
                                            )
                                        }
                                    />
                                    <Button
                                        small
                                        variant='ghost'
                                        title='Finish'
                                        loading={busy === 'finish'}
                                        onPress={() =>
                                            run('finish', () => finishTournament(tournament.id))
                                        }
                                    />
                                </>
                            ) : null}
                        </View>
                    </Card>
                ) : null}

                {/* ---- Sections ---- */}
                <View style={styles.tabs}>
                    {SECTIONS.map((entry) => (
                        <Pressable
                            key={entry.key}
                            onPress={() => setSection(entry.key)}
                            style={[styles.tab, section === entry.key && styles.tabActive]}
                        >
                            <Text
                                style={[
                                    styles.tabText,
                                    section === entry.key && styles.tabTextActive
                                ]}
                            >
                                {entry.label}
                            </Text>
                        </Pressable>
                    ))}
                </View>

                {section === 'info' ? (
                    <Card>
                        {tournament.description ? (
                            <Text style={styles.description}>{tournament.description}</Text>
                        ) : null}
                        <Row label='Organizer' value={tournament.organizer} />
                        <Row label='Game format' value={tournament.gameFormat} />
                        <Row label='Starts' value={localTime(tournament.startTime)} />
                        <Row
                            label='Rounds'
                            value={tournament.roundCount ? String(tournament.roundCount) : null}
                        />
                        <Row
                            label='Best of'
                            value={tournament.bestOf ? String(tournament.bestOf) : null}
                        />
                        <Row
                            label='SAS bound'
                            value={
                                tournament.sasMin != null || tournament.sasMax != null
                                    ? `${tournament.sasMin ?? '–'} to ${tournament.sasMax ?? '–'}`
                                    : null
                            }
                        />
                        <Row
                            label='Entry'
                            value={
                                tournament.entryFeeCents
                                    ? `${(tournament.entryFeeCents / 100).toFixed(2)} ${
                                          tournament.prizeCurrency ?? 'USD'
                                      }`
                                    : null
                            }
                        />
                        <Row label='Prizes' value={tournament.prizeNote} />
                        <Row
                            label='Round deadline'
                            value={
                                tournament.roundDeadlineDays
                                    ? `${tournament.roundDeadlineDays} days`
                                    : null
                            }
                        />
                        {tournament.entryFeeCents ? (
                            <Text style={styles.moneyNote}>
                                Archon Arena records the announced buy-in and split. It never
                                holds or moves the money.
                            </Text>
                        ) : null}
                    </Card>
                ) : null}

                {section === 'players' ? (
                    <Card>
                        {players.length === 0 ? (
                            <EmptyState title='Nobody registered yet' />
                        ) : (
                            players.map((player) => (
                                <View key={player.userId} style={styles.playerRow}>
                                    <Text
                                        style={[
                                            styles.playerName,
                                            player.dropped && styles.dropped
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {player.username}
                                    </Text>
                                    {player.checkedIn ? (
                                        <Text style={styles.tick}>✓</Text>
                                    ) : null}
                                    {player.deckName ? (
                                        <Text style={styles.playerDeck} numberOfLines={1}>
                                            {player.deckName}
                                        </Text>
                                    ) : null}
                                    {typeof player.deckSas === 'number' ? (
                                        <Text style={styles.playerSas}>
                                            {Math.round(player.deckSas)}
                                        </Text>
                                    ) : null}
                                </View>
                            ))
                        )}
                    </Card>
                ) : null}

                {section === 'rounds' ? (
                    rounds.length === 0 ? (
                        <EmptyState title='No rounds yet' />
                    ) : (
                        rounds.map(([round, roundMatches]) => (
                            <Card key={round} style={{ marginBottom: spacing.sm }}>
                                <Text style={styles.cardTitle}>Round {round}</Text>
                                {roundMatches.map((match) => (
                                    <MatchLine
                                        key={match.id}
                                        match={match}
                                        myUserId={myNumericId as number}
                                    />
                                ))}
                            </Card>
                        ))
                    )
                ) : null}

                {section === 'standings' ? (
                    <Card>
                        {standings.length === 0 ? (
                            <EmptyState title='No standings yet' />
                        ) : (
                            standings.map((row) => (
                                <View key={row.id} style={styles.standingRow}>
                                    <Text style={styles.standingRank}>
                                        {row.finalRank ?? row.rank}
                                    </Text>
                                    <Text
                                        style={[
                                            styles.standingName,
                                            row.dropped && styles.dropped
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {row.username}
                                    </Text>
                                    <Text style={styles.standingRecord}>
                                        {row.wins ?? 0}–{row.losses ?? 0}
                                        {row.draws ? `–${row.draws}` : ''}
                                    </Text>
                                </View>
                            ))
                        )}
                    </Card>
                ) : null}
            </ScrollView>

            {/* ---- Deck registration ---- */}
            {deckPicker ? (
                <View style={StyleSheet.absoluteFill}>
                    <View style={styles.deckPicker}>
                        <View style={styles.deckPickerHead}>
                            <Text style={styles.cardTitle}>
                                Choose your deck
                                {tournament.sasMin != null || tournament.sasMax != null
                                    ? ` (SAS ${tournament.sasMin ?? '–'}–${tournament.sasMax ?? '–'})`
                                    : ''}
                            </Text>
                            <Button
                                small
                                variant='secondary'
                                title='Close'
                                onPress={() => setDeckPicker(false)}
                            />
                        </View>
                        <ScrollView contentContainerStyle={{ padding: spacing.md }}>
                            {library.decks.map((deck) => (
                                <DeckRow
                                    key={deck.id}
                                    deck={deck}
                                    onPress={() => setPreviewDeck(deck)}
                                    accessory={
                                        <Button
                                            small
                                            title='Register'
                                            onPress={() =>
                                                run('deck', () =>
                                                    registerTournamentDeck(
                                                        tournament.id,
                                                        Number(deck.id)
                                                    )
                                                ).then(() => setDeckPicker(false))
                                            }
                                        />
                                    }
                                />
                            ))}
                            {library.loading ? (
                                <ActivityIndicator color={colors.brand} />
                            ) : library.decks.length === 0 ? (
                                <EmptyState
                                    title='No eligible decks'
                                    subtitle='This event restricts which decks may be played.'
                                />
                            ) : null}
                            {library.hasMore ? (
                                <Button
                                    variant='secondary'
                                    title='Load more'
                                    onPress={library.loadMore}
                                />
                            ) : null}
                        </ScrollView>
                        <DeckPreview
                            deck={previewDeck}
                            onClose={() => setPreviewDeck(undefined)}
                            confirmLabel='Register this deck'
                            onConfirm={(deck) =>
                                run('deck', () =>
                                    registerTournamentDeck(tournament.id, Number(deck.id))
                                ).then(() => {
                                    setPreviewDeck(undefined);
                                    setDeckPicker(false);
                                })
                            }
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    name: { color: colors.text, fontSize: 20, fontWeight: '800' },
    subtitle: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 3,
        marginBottom: spacing.sm,
        textTransform: 'capitalize'
    },
    announcement: {
        color: colors.text,
        fontSize: 13,
        lineHeight: 18,
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    deadline: { color: colors.warning, fontSize: 12, fontWeight: '700', marginBottom: spacing.sm },
    cardTitle: { color: colors.text, fontSize: 14, fontWeight: '800', marginBottom: 6 },
    cardBody: { color: colors.textDim, fontSize: 12, marginBottom: 4 },
    description: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
    checkedIn: { color: colors.success, fontSize: 12, fontWeight: '700', alignSelf: 'center' },
    tabs: {
        flexDirection: 'row',
        gap: 4,
        marginBottom: spacing.sm,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        borderColor: colors.border,
        borderWidth: 1,
        padding: 3
    },
    tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.sm },
    tabActive: { backgroundColor: colors.surfaceHover },
    tabText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
    tabTextActive: { color: colors.text, fontWeight: '800' },
    infoRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: 5,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    infoLabel: { color: colors.textFaint, fontSize: 12 },
    infoValue: { color: colors.text, fontSize: 12, fontWeight: '600', flexShrink: 1 },
    moneyNote: { color: colors.textFaint, fontSize: 10, lineHeight: 14, marginTop: spacing.sm },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 7,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    playerName: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
    dropped: { textDecorationLine: 'line-through', color: colors.textFaint },
    tick: { color: colors.success, fontSize: 12 },
    playerDeck: { color: colors.textFaint, fontSize: 11, maxWidth: '40%' },
    playerSas: { color: colors.brand, fontSize: 11, fontWeight: '800' },
    matchLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 6,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    matchLineMine: { backgroundColor: 'rgba(232, 163, 61, 0.08)' },
    matchTable: { color: colors.textFaint, fontSize: 11, width: 28 },
    matchNames: { color: colors.textDim, fontSize: 12, flex: 1 },
    matchResult: { color: colors.textFaint, fontSize: 11, fontWeight: '700' },
    standingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: 7,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    standingRank: {
        color: colors.textFaint,
        fontSize: 12,
        fontWeight: '800',
        width: 26,
        textAlign: 'right'
    },
    standingName: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
    standingRecord: { color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
    deckPicker: { flex: 1, backgroundColor: colors.bg },
    deckPickerHead: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        padding: spacing.md,
        paddingTop: spacing.xl
    }
});
