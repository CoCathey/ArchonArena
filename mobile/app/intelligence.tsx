import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
    fetchDeckIntelligence,
    fetchMetaIntelligence,
    fetchPlayerIntelligence,
    fetchReplayIntelligence
} from '../src/api/client';
import type {
    DeckIntelligenceResult,
    DeckRanking,
    MetaIntelligenceResult,
    PlayerIntelligenceResult,
    ReplayIntelligenceResult
} from '../src/api/types';
import { CAPABILITIES } from '../src/membership/capabilities';
import SetFilter from '../src/membership/SetFilter';
import { hasAnyCapability, hasCapability } from '../src/membership/entitlements';
import PremiumLock from '../src/membership/PremiumLock';
import AercSection from '../src/stats/AercSection';
import DeckComparisonSection from '../src/stats/DeckComparisonSection';
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
import {
    opposingHouseBars,
    replayHeadline,
    replayHouseBars
} from '../src/membership/replayIntelligence';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import BarList from '../src/ui/BarList';
import HouseIcon from '../src/ui/HouseIcon';
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

    const canReplays = hasCapability(user, CAPABILITIES.ADVANCED_REPLAYS);

    const [player, setPlayer] = useState<PlayerIntelligenceResult | undefined>();
    const [meta, setMeta] = useState<MetaIntelligenceResult | undefined>();
    const [replays, setReplays] = useState<ReplayIntelligenceResult | undefined>();
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

    /**
     * ARCHON (N12): Replay Intelligence loads on its own, NOT inside `load`.
     *
     * Everything else here re-reads when the set filter changes. This one
     * cannot be narrowed by set — a recording is a game, not the deck row the
     * filter is built from — and each request has the server parse 25 stored
     * JSON documents. Folding it into `load` would repeat all of that on every
     * tap of a set chip, for an answer that never changes: a slow request and a
     * chunk of somebody's data allowance, twice over, for nothing.
     */
    const loadReplays = useCallback(async () => {
        if (!canReplays) {
            return;
        }

        try {
            setReplays(await fetchReplayIntelligence(25));
        } catch {
            // Reported in the panel rather than in the screen's error banner,
            // which belongs to the filtered payload the rest of the page is
            // built on. Said explicitly, because falling through to the empty
            // state would tell someone with a hundred recorded games that they
            // have none — the one reading a failed request must not produce.
            setReplays({
                success: false,
                available: false,
                reason: 'Could not load your replay analysis. Pull down to try again.'
            });
        }
    }, [canReplays]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        loadReplays();
    }, [loadReplays]);

    const vs = player?.vsExpectation;
    const headline = replayHeadline(replays);
    const rankings = player?.rankings ?? [];
    const history = player?.ratingHistory ?? [];

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: colors.bg }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl
                    refreshing={loading}
                    onRefresh={() => {
                        load();
                        loadReplays();
                    }}
                    tintColor={colors.brand}
                />
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

            {/* ---- Deck comparison ------------------------------------- */}
            {/* ARCHON (N12): distinct from the Tournament Lab, which asks
                which deck to BRING. This asks the plainer question — what do
                these decks actually do — and answers it in columns. */}
            <Card>
                <Text style={styles.panelTitle}>Compare decks</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.DECK_COMPARISON]}
                    pitch='Put two to four of your decks side by side on the record you actually have with them.'
                >
                    <DeckComparisonSection decks={rankings} />
                </PremiumLock>
            </Card>

            {/* ---- AERC analytics -------------------------------------- */}
            <Card>
                <Text style={styles.panelTitle}>AERC analytics</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.AERC_ANALYTICS]}
                    pitch='Which kind of deck you play well, and which kind beats you — read in AERC terms rather than by house.'
                >
                    <AercSection />
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
                                Measured across decks that contain each house — not the house you
                                called on a given turn, which is recorded only inside replays.
                                Replay Intelligence, below, is the per-turn figure.
                            </Muted>
                        </View>
                    ) : (
                        <Muted>No games recorded yet.</Muted>
                    )}
                </PremiumLock>
            </Card>

            {/* ---- Replay Intelligence --------------------------------- */}
            {/* ARCHON (N12): the only panel here whose numbers come out of
                recorded games rather than a column, and the only place on the
                site that knows which house a player actually called. Every
                other house figure on this screen counts decks CONTAINING a
                house, which is a different and weaker claim.

                It reads well on a phone precisely because it is a list of
                houses with one number each — the web page's five-column row
                folds down to a bar, a percentage and a sub-line, and the house
                icons make it scan faster here than it does there. */}
            <Card>
                <Text style={styles.panelTitle}>Replay Intelligence</Text>
                <PremiumLock
                    capabilities={[CAPABILITIES.ADVANCED_REPLAYS]}
                    pitch='See which house you actually call each turn, and how you do when you call it.'
                >
                    {replays?.available ? (
                        <View style={{ gap: spacing.md }}>
                            {headline ? (
                                <Text style={styles.headline}>
                                    You call{' '}
                                    <Text style={styles.headlineHouse}>{headline.houseName}</Text>{' '}
                                    more than any other house
                                    {headline.winRate === null
                                        ? '.'
                                        : `, and win ${pct(headline.winRate)} of the games you call it in.`}
                                </Text>
                            ) : null}

                            <StatGrid>
                                <Stat
                                    hint={`${replays.wins ?? 0} won`}
                                    label='Games read'
                                    value={replays.games ?? 0}
                                />
                                <Stat
                                    hint='turns that gained any'
                                    label='Amber per turn'
                                    value={num(replays.amberPerTurn)}
                                />
                                <Stat
                                    hint='average turn'
                                    label='First key'
                                    value={num(replays.firstKeyRound)}
                                />
                                <Stat
                                    hint='your turns'
                                    label='Game length'
                                    value={num(replays.turnsPerGame)}
                                />
                            </StatGrid>

                            <View>
                                <SectionLabel>Houses you call</SectionLabel>
                                <BarList
                                    emptyText='No houses recorded yet.'
                                    items={replayHouseBars(replays.byHouse).map((item) => ({
                                        ...item,
                                        icon: <HouseIcon house={item.key} size={15} />
                                    }))}
                                    marker={50}
                                />
                                <Muted>
                                    Counted per turn, from recorded board states. The win rate is
                                    over the games you called it in at least once; the line marks
                                    even.
                                </Muted>
                            </View>

                            {(replays.vsHouse ?? []).length ? (
                                <View>
                                    <SectionLabel>What the other side called</SectionLabel>
                                    <BarList
                                        items={opposingHouseBars(replays.vsHouse).map((item) => ({
                                            ...item,
                                            icon: <HouseIcon house={item.key} size={15} />
                                        }))}
                                        marker={50}
                                    />
                                </View>
                            ) : null}

                            <Muted>
                                Read from your last {replays.games ?? 0} recorded games, and not
                                narrowed by the set filter — a recording is a game, not a deck.
                                {(replays.skipped ?? 0) > 0
                                    ? ` ${replays.skipped} more were recorded before board states were captured and could not be read.`
                                    : ''}
                            </Muted>
                        </View>
                    ) : (
                        <Muted>
                            {replays?.reason ??
                                'No recorded games yet — finish one and it is read here.'}
                        </Muted>
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
    headline: {
        color: colors.text,
        fontSize: 14,
        lineHeight: 20
    },
    headlineHouse: {
        color: colors.brand,
        fontWeight: '700'
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
