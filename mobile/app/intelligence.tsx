import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
    fetchDeckIntelligence,
    fetchMetaIntelligence,
    fetchPlayerIntelligence
} from '../src/api/client';
import type {
    DeckIntelligenceResult,
    DeckRanking,
    MetaIntelligenceResult,
    PlayerIntelligenceResult
} from '../src/api/types';
import { CAPABILITIES } from '../src/membership/capabilities';
import SetFilter from '../src/membership/SetFilter';
import { hasAnyCapability, hasCapability } from '../src/membership/entitlements';
import PremiumLock from '../src/membership/PremiumLock';
import {
    duration,
    HouseBar,
    SetBar,
    Muted,
    num,
    pct,
    RatingSparkline,
    SectionLabel,
    signed,
    Stat,
    StatGrid
} from '../src/membership/widgets';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Card, ErrorBanner } from '../src/ui/primitives';

/**
 * ARCHON (N12): Archon Intelligence on the phone.
 *
 * The same three questions the web page asks, in the same order, because the
 * order is the argument:
 *
 *   Deck Intelligence   — is this actually a good deck?
 *   Player Intelligence — am I actually good with it?
 *   Meta Intelligence   — how does it hold up against what people play?
 *
 * Every panel is gated on its own capability rather than on the screen as a
 * whole. That matters for what a Supporter sees: rating history and the
 * performance dashboard are theirs at $5, while deck rankings and matchups are
 * Archon, and gating the screen on the highest of them would lock a paying
 * Supporter out of what they bought. The server gates the payload the same way
 * and returns `locked` naming the sections it withheld.
 *
 * Nothing here fabricates a number. A metric the server could not compute comes
 * back as `available: false` with a reason, and the reason is what is rendered.
 */

const PLAYER_SECTIONS = [
    CAPABILITIES.ELO_HISTORY,
    CAPABILITIES.PERFORMANCE_DASHBOARD,
    CAPABILITIES.PERSONAL_DECK_RANKINGS,
    CAPABILITIES.MATCHUP_ANALYTICS
];

function DeckChips(props: {
    decks: DeckRanking[];
    selected?: number;
    onSelect: (deckId: number) => void;
}) {
    return (
        <View style={styles.chipRow}>
            {props.decks.slice(0, 12).map((deck) => {
                const active = deck.deckId === props.selected;

                return (
                    <Pressable
                        key={deck.deckId}
                        onPress={() => props.onSelect(deck.deckId)}
                        style={[styles.chip, active ? styles.chipActive : null]}
                    >
                        <Text
                            numberOfLines={1}
                            style={[styles.chipText, active ? styles.chipTextActive : null]}
                        >
                            {deck.deckName}
                        </Text>
                        <Text style={styles.chipGames}>{deck.games}g</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

/** "Is this deck good?" — the first question, and the one that had no surface. */
function DeckIntelligence(props: { decks: DeckRanking[] }) {
    const [deckId, setDeckId] = useState<number | undefined>();
    const [data, setData] = useState<DeckIntelligenceResult | undefined>();
    const [loading, setLoading] = useState(false);

    const selected = deckId ?? props.decks[0]?.deckId;

    useEffect(() => {
        if (!selected) {
            return;
        }

        let cancelled = false;

        setLoading(true);
        fetchDeckIntelligence(selected)
            .then((result) => {
                if (!cancelled) {
                    setData(result);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setData(undefined);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [selected]);

    if (!props.decks.length) {
        return <Muted>Play a few games with a deck and its breakdown appears here.</Muted>;
    }

    const mine = data?.mine;
    const everyone = data?.everyone;
    const overview = mine?.overview;

    return (
        <View style={{ gap: spacing.md }}>
            <DeckChips decks={props.decks} onSelect={setDeckId} selected={selected} />

            {loading ? <Muted>Loading…</Muted> : null}

            {overview?.available ? (
                <>
                    <StatGrid>
                        <Stat
                            hint={pct(overview.winRate)}
                            label='Your record'
                            value={`${overview.wins ?? 0}–${overview.losses ?? 0}`}
                        />
                        <Stat
                            hint='caps at 3 for online games'
                            label='Avg keys at end'
                            value={num(overview.avgKeysAtEnd)}
                        />
                        <Stat label='Avg length' value={duration(overview.avgSeconds)} />
                        <Stat
                            label='Rating swing'
                            tone={(mine?.rating?.netSwing ?? 0) >= 0 ? 'good' : 'bad'}
                            value={mine?.rating?.available ? signed(mine.rating.netSwing) : '—'}
                        />
                    </StatGrid>

                    {everyone?.available && (everyone.games ?? 0) > (overview.games ?? 0) ? (
                        <Muted>
                            Across every player who has used this deck: {everyone.wins}–
                            {everyone.losses} ({pct(everyone.winRate)}).
                        </Muted>
                    ) : null}

                    {mine?.byOpposingHouse?.available ? (
                        <View>
                            <SectionLabel>Against decks containing</SectionLabel>
                            {(mine.byOpposingHouse.rows ?? []).map((row) => (
                                <HouseBar key={row.house} row={row} />
                            ))}
                        </View>
                    ) : null}

                    <Muted>
                        {mine?.byTurnOrder?.available
                            ? `Going first: ${pct(mine.byTurnOrder.first?.winRate)} · Going second: ${pct(
                                  mine.byTurnOrder.second?.winRate
                              )}`
                            : (mine?.byTurnOrder?.reason ?? '')}
                    </Muted>
                </>
            ) : null}

            {mine && !overview?.available && !loading ? (
                <Muted>No finished games with this deck yet.</Muted>
            ) : null}
        </View>
    );
}

export default function IntelligenceScreen() {
    const user = useAuthStore((state) => state.user);
    const unlocked = hasAnyCapability(user, PLAYER_SECTIONS);
    const canMeta = hasCapability(user, CAPABILITIES.META_ANALYTICS);

    const [player, setPlayer] = useState<PlayerIntelligenceResult | undefined>();
    const [meta, setMeta] = useState<MetaIntelligenceResult | undefined>();
    const [sets, setSets] = useState<number[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        // Skipped entirely when locked: a 403 per panel teaches nobody
        // anything, and the locked state renders from the catalogue copy.
        if (!unlocked && !canMeta) {
            return;
        }

        setLoading(true);
        setError(undefined);

        try {
            const [playerResult, metaResult] = await Promise.all([
                unlocked ? fetchPlayerIntelligence(sets) : Promise.resolve(undefined),
                canMeta ? fetchMetaIntelligence(30, sets) : Promise.resolve(undefined)
            ]);

            setPlayer(playerResult);
            setMeta(metaResult);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load Archon Intelligence.');
        } finally {
            setLoading(false);
        }
    }, [canMeta, sets, unlocked]);

    useEffect(() => {
        load();
    }, [load]);

    const vs = player?.vsExpectation;
    const rankings = player?.rankings ?? [];
    const history = player?.ratingHistory ?? [];

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: colors.bg }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.brand} />
            }
        >
            <ErrorBanner message={error} />

            <Card>
                <Text style={styles.lead}>
                    Three questions: is the deck good, are you good with it, and how does it hold up
                    against what people are actually playing?
                </Text>
                {/* ARCHON: one control, and everything below it re-reads for
                    those sets — a house win rate or a "vs expectation" means
                    something different inside one set than averaged over
                    twenty. The two by-set tables deliberately ignore it: they
                    are what the filter is chosen FROM, and narrowing them would
                    collapse each to one row. */}
                {unlocked || canMeta ? (
                    <View style={{ marginTop: spacing.md }}>
                        <SetFilter disabled={loading} onChange={setSets} selected={sets} />
                    </View>
                ) : null}
            </Card>

            {/* ---- Player Intelligence ---------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>Player Intelligence</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.PERFORMANCE_DASHBOARD]}
                    pitch='See whether you are beating what your rating predicted, across your whole record.'
                >
                    {vs?.available ? (
                        <View style={{ gap: spacing.sm }}>
                            <StatGrid>
                                <Stat label='Rated games' value={vs.games ?? 0} />
                                <Stat label='Win rate' value={pct(vs.winRate)} />
                                <Stat
                                    hint='what your rating predicted'
                                    label='Expected'
                                    value={pct(vs.expectedWinRate)}
                                />
                                <Stat
                                    hint='wins above/below prediction'
                                    label='vs expectation'
                                    tone={(vs.vsExpectation ?? 0) >= 0 ? 'good' : 'bad'}
                                    value={signed(vs.vsExpectation, 1)}
                                />
                            </StatGrid>
                            <Muted>
                                The rating engine records what it expected before each game was
                                played. The gap between that and what happened is the part that is
                                you rather than the matchup.
                            </Muted>
                        </View>
                    ) : (
                        <Muted>{vs?.reason ?? 'No rated games yet — play a few and come back.'}</Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Elo history (Supporter) ------------------------------ */}
            <Card>
                <Text style={styles.panelTitle}>Your rating history</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.ELO_HISTORY]}
                    pitch='See how your rating moved game by game, not just your current number.'
                >
                    {history.length ? (
                        <View style={{ gap: spacing.sm }}>
                            <StatGrid>
                                <Stat
                                    label='Current'
                                    value={history[history.length - 1].ratingAfter}
                                />
                                <Stat
                                    label='Net change'
                                    tone={
                                        history[history.length - 1].ratingAfter -
                                            history[0].ratingBefore >=
                                        0
                                            ? 'good'
                                            : 'bad'
                                    }
                                    value={signed(
                                        history[history.length - 1].ratingAfter -
                                            history[0].ratingBefore
                                    )}
                                />
                                <Stat
                                    label='Peak'
                                    value={Math.max(...history.map((entry) => entry.ratingAfter))}
                                />
                                <Stat label='Rated games' value={history.length} />
                            </StatGrid>

                            <RatingSparkline history={history} />

                            <View>
                                <SectionLabel>Most recent</SectionLabel>
                                {[...history]
                                    .reverse()
                                    .slice(0, 15)
                                    .map((entry, index) => (
                                        <View key={index} style={styles.historyRow}>
                                            <Text numberOfLines={1} style={styles.historyOpponent}>
                                                {entry.opponent || '—'}
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.historyResult,
                                                    {
                                                        color: entry.won
                                                            ? colors.success
                                                            : colors.danger
                                                    }
                                                ]}
                                            >
                                                {entry.won ? 'Win' : 'Loss'}
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.historyChange,
                                                    {
                                                        color:
                                                            entry.change >= 0
                                                                ? colors.success
                                                                : colors.danger
                                                    }
                                                ]}
                                            >
                                                {signed(entry.change)}
                                            </Text>
                                            <Text style={styles.historyRating}>
                                                {entry.ratingAfter}
                                            </Text>
                                        </View>
                                    ))}
                            </View>
                        </View>
                    ) : (
                        <Muted>
                            No rated games yet — your rating history appears here once you play.
                        </Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Deck Intelligence: is this deck good? ---------------- */}
            <Card>
                <Text style={styles.panelTitle}>Deck Intelligence — is this deck good?</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.ARCHON_INTELLIGENCE]}
                    pitch='Pick a deck and see its record, what it beats, and how the rating moved while you played it.'
                >
                    <DeckIntelligence decks={rankings} />
                </PremiumLock>
            </Card>

            {/* ---- Deck rankings --------------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>Your decks ranked</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.PERSONAL_DECK_RANKINGS]}
                    pitch='Rank your own decks by how they actually perform for you.'
                >
                    {rankings.length ? (
                        <View>
                            {rankings.map((deck) => (
                                <View key={deck.deckId} style={styles.rankRow}>
                                    <Text numberOfLines={1} style={styles.rankName}>
                                        {deck.deckName}
                                    </Text>
                                    <Text style={styles.rankRecord}>
                                        {deck.wins}–{deck.losses}
                                    </Text>
                                    <Text style={styles.rankRate}>{pct(deck.winRate)}</Text>
                                    <Text style={styles.rankSas}>{deck.sas ?? '—'}</Text>
                                </View>
                            ))}
                        </View>
                    ) : (
                        <Muted>Play a few games with your decks and their records appear here.</Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Matchups -------------------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>Your record by house</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.MATCHUP_ANALYTICS]}
                    pitch='See which opposing houses you beat and which ones consistently beat you.'
                >
                    {(player?.byHouse ?? []).length ? (
                        <View>
                            {(player?.byHouse ?? []).map((row) => (
                                <HouseBar key={row.house} row={row} />
                            ))}
                            <Muted>
                                Measured across decks that contain each house. Which house you chose
                                on a given turn is not recorded outside replays, so this is not a
                                per-turn figure.
                            </Muted>
                        </View>
                    ) : (
                        <Muted>No games recorded yet.</Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Your record by set ---------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>Your record by set</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.MATCHUP_ANALYTICS]}
                    pitch='See which sets you actually win in, and how much of your play each one is.'
                >
                    {(player?.bySet ?? []).length ? (
                        <View>
                            {(player?.bySet ?? []).map((row) => (
                                <SetBar key={row.set?.code ?? row.set?.name} row={row} />
                            ))}
                            <Muted>
                                Not narrowed by the filter above — this is the table the filter is
                                chosen from.
                            </Muted>
                        </View>
                    ) : (
                        <Muted>No games recorded yet.</Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Meta Intelligence ----------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>Meta Intelligence</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.META_ANALYTICS]}
                    pitch='See what the field is actually playing and how it is performing.'
                >
                    <View style={{ gap: spacing.sm }}>
                        {meta?.summary?.available ? (
                            <StatGrid>
                                <Stat label='Games' value={meta.summary.games ?? 0} />
                                <Stat label='Players' value={meta.summary.players ?? 0} />
                                <Stat label='Decks' value={meta.summary.decks ?? 0} />
                                <Stat
                                    label='Avg length'
                                    value={duration(meta.summary.avgSeconds)}
                                />
                            </StatGrid>
                        ) : null}
                        {(meta?.houses?.rows ?? []).map((row) => (
                            <HouseBar key={row.house} row={row} />
                        ))}
                        {(meta?.bySet?.rows ?? []).length ? (
                            <View>
                                <SectionLabel>What the field is playing, by set</SectionLabel>
                                {(meta?.bySet?.rows ?? []).slice(0, 10).map((row) => (
                                    <SetBar key={row.set?.code ?? row.set?.name} row={row} />
                                ))}
                            </View>
                        ) : null}
                        <Muted>
                            Across all decided games in the last {meta?.days ?? 30} days.
                        </Muted>
                    </View>
                </PremiumLock>
            </Card>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    lead: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19
    },
    panelTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        maxWidth: 190
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: 'rgba(232,163,61,0.15)'
    },
    chipText: {
        color: colors.text,
        fontSize: 12,
        flexShrink: 1
    },
    chipTextActive: {
        color: colors.brand,
        fontWeight: '600'
    },
    chipGames: {
        color: colors.textFaint,
        fontSize: 11
    },
    historyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 5,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border
    },
    historyOpponent: {
        flex: 1,
        color: colors.text,
        fontSize: 12
    },
    historyResult: {
        width: 44,
        fontSize: 12,
        textAlign: 'right'
    },
    historyChange: {
        width: 46,
        fontSize: 12,
        textAlign: 'right'
    },
    historyRating: {
        width: 48,
        color: colors.textDim,
        fontSize: 12,
        textAlign: 'right'
    },
    rankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border
    },
    rankName: {
        flex: 1,
        color: colors.text,
        fontSize: 13
    },
    rankRecord: {
        width: 56,
        color: colors.textDim,
        fontSize: 12,
        textAlign: 'right'
    },
    rankRate: {
        width: 48,
        color: colors.text,
        fontSize: 12,
        textAlign: 'right'
    },
    rankSas: {
        width: 40,
        color: colors.textFaint,
        fontSize: 12,
        textAlign: 'right'
    }
});
