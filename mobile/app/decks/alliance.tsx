import React, { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
    createAllianceDeck,
    fetchDeck,
    type AllianceRequest
} from '../../src/api/client';
import type { Deck, DeckCard } from '../../src/api/types';
import { expansionLabel } from '../../src/decks/expansions';
import { useDeckLibrary } from '../../src/decks/useDeckLibrary';
import { useCardsStore } from '../../src/stores/cardsStore';
import { colors, radius, spacing } from '../../src/theme';
import HouseIcon from '../../src/ui/HouseIcon';
import { houseLabel } from '../../src/ui/houseNames';
import { Button, Card, ErrorBanner, TextField } from '../../src/ui/primitives';

/**
 * ARCHON: the alliance deck builder.
 *
 * An alliance deck is one house pod taken from each of three different decks.
 * The app could PLAY an alliance deck — the picker offers them in an alliance
 * game — and could never build one, so every alliance deck on a phone had to
 * be made in a browser first.
 *
 * Two rules come from the sets rather than from the format, and the server
 * enforces both:
 *  - WoE and ToC decks bring a token creature, and an alliance made from them
 *    must name which deck's token it uses.
 *  - Prophecy sets (PV) need one deck named as the prophecy source.
 *
 * Every pod must come from the same expansion, which is why the set is chosen
 * first and the deck list is filtered by it.
 */

/** Sets whose decks carry a token creature (client/constants.js). */
const TOKEN_EXPANSIONS = new Set([600, 855]);

/** Sets that have prophecies. */
const PROPHECY_EXPANSIONS = new Set([886]);

interface PodChoice {
    deck: Deck;
    house: string;
}

function DeckPicker(props: {
    decks: Deck[];
    selectedUuid?: string;
    disabledUuids: Set<string>;
    onSelect: (deck: Deck) => void;
}) {
    return (
        <View style={styles.deckList}>
            {props.decks.map((deck) => {
                const uuid = String(deck.uuid ?? deck.id);
                const taken = props.disabledUuids.has(uuid);
                const active = props.selectedUuid === uuid;

                return (
                    <Pressable
                        key={uuid}
                        onPress={() => !taken && props.onSelect(deck)}
                        disabled={taken}
                        style={[
                            styles.deckRow,
                            active && styles.deckRowActive,
                            taken && { opacity: 0.35 }
                        ]}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={styles.deckName} numberOfLines={1}>
                                {deck.name}
                            </Text>
                            <View style={styles.houseRow}>
                                {(deck.houses ?? []).map((house) => (
                                    <HouseIcon key={house} house={house} size={16} />
                                ))}
                                {expansionLabel(deck.expansion) ? (
                                    <Text style={styles.deckMeta}>
                                        {expansionLabel(deck.expansion)}
                                    </Text>
                                ) : null}
                            </View>
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}

export default function AllianceBuilderScreen() {
    // Alliance decks cannot be built out of other alliance decks, and the set
    // filter is applied here rather than server-side because the server has no
    // "same expansion" filter — it validates the result instead.
    const library = useDeckLibrary({ pageSize: 200, isAlliance: false });
    const cards = useCardsStore((state) => state.cards);
    const loadCards = useCardsStore((state) => state.load);

    const [name, setName] = useState('');
    const [expansion, setExpansion] = useState<number | undefined>();
    const [pods, setPods] = useState<(PodChoice | undefined)[]>([undefined, undefined, undefined]);
    const [slot, setSlot] = useState<number | undefined>(0);
    const [tokenDeckUuid, setTokenDeckUuid] = useState<string | undefined>();
    const [prophecyDeckUuid, setProphecyDeckUuid] = useState<string | undefined>();
    const [tokenId, setTokenId] = useState<string | undefined>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        loadCards();
    }, [loadCards]);

    // Which sets the player actually owns decks from — offering the full set
    // list would advertise sets they cannot build with.
    const expansions = useMemo(() => {
        const seen = new Map<number, string>();
        for (const deck of library.decks) {
            if (typeof deck.expansion === 'number') {
                seen.set(deck.expansion, expansionLabel(deck.expansion) ?? String(deck.expansion));
            }
        }

        return [...seen.entries()]
            .map(([id, label]) => ({ id, label }))
            .sort((a, b) => b.id - a.id);
    }, [library.decks]);

    const eligible = useMemo(
        () => library.decks.filter((deck) => deck.expansion === expansion),
        [library.decks, expansion]
    );

    const chosen = pods.filter((pod): pod is PodChoice => !!pod);
    const usedUuids = new Set(chosen.map((pod) => String(pod.deck.uuid ?? pod.deck.id)));
    const usedHouses = new Set(chosen.map((pod) => pod.house));

    const needsToken = expansion !== undefined && TOKEN_EXPANSIONS.has(expansion);
    const supportsProphecy = expansion !== undefined && PROPHECY_EXPANSIONS.has(expansion);

    // Prophecy selection is deliberately not gated here. Whether one is
    // REQUIRED depends on how many of the three decks actually carry
    // prophecies, which means loading three full card lists to find out — and
    // the server already refuses with a readable sentence when it needs one.
    const ready =
        !!name.trim() &&
        chosen.length === 3 &&
        usedHouses.size === 3 &&
        (!needsToken || !!tokenDeckUuid);

    const resetPods = () => {
        setPods([undefined, undefined, undefined]);
        setSlot(0);
        setTokenDeckUuid(undefined);
        setProphecyDeckUuid(undefined);
        setTokenId(undefined);
    };

    /**
     * The token creature a deck brings. It is a card in the deck list with a
     * `type` of "token creature"; the alliance needs its card id, which is
     * what the server stores as the alliance's own token.
     */
    const loadTokenFor = async (deckId: Deck['id']) => {
        try {
            const result = await fetchDeck(deckId);
            const list = (result.deck?.cards ?? []) as DeckCard[];
            const token = list.find((card) => {
                const dictionary = cards?.[String(card.id)];

                return dictionary?.type === 'token creature';
            });
            setTokenId(token ? String(token.id) : undefined);
        } catch {
            // Leave it unset: the server refuses a token set that names no
            // card, which is a better outcome than saving a wrong one.
            setTokenId(undefined);
        }
    };

    const save = async () => {
        setError(undefined);
        const podStrings = chosen.map((pod) => `${pod.deck.uuid}:${pod.house}`);

        const body: AllianceRequest = {
            name: name.trim(),
            pods: podStrings
        };

        if (needsToken && tokenDeckUuid) {
            body.tokenSourceDeck = tokenDeckUuid;
            if (tokenId) {
                body.token = { id: tokenId };
            }
        }
        if (supportsProphecy && prophecyDeckUuid) {
            body.prophecySourceDeck = prophecyDeckUuid;
        }

        setSaving(true);
        try {
            const result = await createAllianceDeck(body);
            if (!result.success) {
                setError(result.message ?? 'Could not build that alliance');
                return;
            }
            router.back();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not build that alliance');
        } finally {
            setSaving(false);
        }
    };

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            keyboardShouldPersistTaps='handled'
        >
            <ErrorBanner message={error ?? library.error} />

            <Card style={{ marginBottom: spacing.md }}>
                <TextField
                    label='Alliance name'
                    value={name}
                    onChangeText={setName}
                    placeholder='Name your alliance'
                    autoCapitalize='words'
                />

                <Text style={styles.label}>Set</Text>
                <Text style={styles.hint}>
                    Every pod has to come from the same set.
                </Text>
                <View style={styles.chipRow}>
                    {expansions.map((entry) => (
                        <Pressable
                            key={entry.id}
                            onPress={() => {
                                setExpansion(entry.id);
                                resetPods();
                            }}
                            style={[styles.chip, expansion === entry.id && styles.chipActive]}
                        >
                            <Text
                                style={[
                                    styles.chipText,
                                    expansion === entry.id && styles.chipTextActive
                                ]}
                            >
                                {entry.label}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                {expansions.length === 0 ? (
                    <Text style={styles.hint}>
                        {library.loading ? 'Loading your decks…' : 'Import some decks first.'}
                    </Text>
                ) : null}
            </Card>

            {expansion !== undefined ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Three pods, three houses</Text>
                    <View style={styles.slotRow}>
                        {pods.map((pod, index) => (
                            <Pressable
                                key={index}
                                onPress={() => setSlot(index)}
                                style={[styles.slot, slot === index && styles.slotActive]}
                            >
                                {pod ? (
                                    <>
                                        <HouseIcon house={pod.house} size={26} />
                                        <Text style={styles.slotHouse}>
                                            {houseLabel(pod.house)}
                                        </Text>
                                        <Text style={styles.slotDeck} numberOfLines={1}>
                                            {pod.deck.name}
                                        </Text>
                                    </>
                                ) : (
                                    <Text style={styles.slotEmpty}>Pod {index + 1}</Text>
                                )}
                            </Pressable>
                        ))}
                    </View>

                    {slot !== undefined ? (
                        <>
                            {pods[slot] ? (
                                <Button
                                    small
                                    variant='secondary'
                                    title='Clear this pod'
                                    onPress={() =>
                                        setPods((current) =>
                                            current.map((pod, index) =>
                                                index === slot ? undefined : pod
                                            )
                                        )
                                    }
                                    style={{ alignSelf: 'flex-start', marginBottom: spacing.sm }}
                                />
                            ) : null}

                            <Text style={styles.label}>
                                Pick a deck for pod {slot + 1}
                            </Text>
                            <DeckPicker
                                decks={eligible}
                                selectedUuid={
                                    pods[slot]
                                        ? String(pods[slot]?.deck.uuid ?? pods[slot]?.deck.id)
                                        : undefined
                                }
                                disabledUuids={
                                    new Set(
                                        [...usedUuids].filter(
                                            (uuid) =>
                                                uuid !==
                                                String(pods[slot]?.deck.uuid ?? pods[slot]?.deck.id)
                                        )
                                    )
                                }
                                onSelect={(deck) => {
                                    // Pick the deck, then its house — a deck
                                    // with all three houses already taken is
                                    // still a legal pick if one of them is the
                                    // one this slot holds.
                                    setPods((current) =>
                                        current.map((pod, index) =>
                                            index === slot
                                                ? {
                                                      deck,
                                                      house:
                                                          (deck.houses ?? []).find(
                                                              (house) => !usedHouses.has(house)
                                                          ) ??
                                                          (deck.houses ?? [])[0] ??
                                                          ''
                                                  }
                                                : pod
                                        )
                                    );
                                }}
                            />

                            {pods[slot] ? (
                                <>
                                    <Text style={styles.label}>House from this deck</Text>
                                    <View style={styles.chipRow}>
                                        {(pods[slot]?.deck.houses ?? []).map((house) => {
                                            const takenElsewhere = chosen.some(
                                                (pod, index) =>
                                                    index !== slot && pod.house === house
                                            );

                                            return (
                                                <Pressable
                                                    key={house}
                                                    disabled={takenElsewhere}
                                                    onPress={() =>
                                                        setPods((current) =>
                                                            current.map((pod, index) =>
                                                                index === slot && pod
                                                                    ? { ...pod, house }
                                                                    : pod
                                                            )
                                                        )
                                                    }
                                                    style={[
                                                        styles.chip,
                                                        pods[slot]?.house === house &&
                                                            styles.chipActive,
                                                        takenElsewhere && { opacity: 0.3 }
                                                    ]}
                                                >
                                                    <HouseIcon house={house} size={16} />
                                                    <Text
                                                        style={[
                                                            styles.chipText,
                                                            pods[slot]?.house === house &&
                                                                styles.chipTextActive
                                                        ]}
                                                    >
                                                        {houseLabel(house)}
                                                    </Text>
                                                </Pressable>
                                            );
                                        })}
                                    </View>
                                </>
                            ) : null}
                        </>
                    ) : null}
                </Card>
            ) : null}

            {needsToken && chosen.length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Token creature</Text>
                    <Text style={styles.hint}>
                        Decks from this set make a token creature. Choose which of your three
                        decks provides it.
                    </Text>
                    <View style={styles.chipRow}>
                        {chosen.map((pod) => {
                            const uuid = String(pod.deck.uuid ?? pod.deck.id);

                            return (
                                <Pressable
                                    key={uuid}
                                    onPress={() => {
                                        setTokenDeckUuid(uuid);
                                        loadTokenFor(pod.deck.id);
                                    }}
                                    style={[styles.chip, tokenDeckUuid === uuid && styles.chipActive]}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            tokenDeckUuid === uuid && styles.chipTextActive
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {pod.deck.name}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </Card>
            ) : null}

            {supportsProphecy && chosen.length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Prophecies</Text>
                    <Text style={styles.hint}>
                        Choose which deck's prophecies the alliance plays with.
                    </Text>
                    <View style={styles.chipRow}>
                        {chosen.map((pod) => {
                            const uuid = String(pod.deck.uuid ?? pod.deck.id);

                            return (
                                <Pressable
                                    key={uuid}
                                    onPress={() => setProphecyDeckUuid(uuid)}
                                    style={[
                                        styles.chip,
                                        prophecyDeckUuid === uuid && styles.chipActive
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            prophecyDeckUuid === uuid && styles.chipTextActive
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {pod.deck.name}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </Card>
            ) : null}

            <Button
                title='Build alliance'
                loading={saving}
                disabled={!ready}
                onPress={save}
            />
            <Text style={styles.hint}>
                {chosen.length < 3
                    ? `${3 - chosen.length} pod${chosen.length === 2 ? '' : 's'} still to pick.`
                    : usedHouses.size < 3
                    ? 'Each pod has to be a different house.'
                    : needsToken && !tokenDeckUuid
                    ? 'Choose a token source deck.'
                    : !name.trim()
                    ? 'Give the alliance a name.'
                    : 'Ready to build.'}
            </Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4
    },
    label: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600',
        marginTop: spacing.sm,
        marginBottom: 4
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 4
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 6
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        backgroundColor: colors.bgElevated,
        maxWidth: '100%'
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600',
        flexShrink: 1
    },
    chipTextActive: {
        color: colors.brand
    },
    slotRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.sm,
        marginBottom: spacing.sm
    },
    slot: {
        flex: 1,
        alignItems: 'center',
        gap: 2,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingVertical: spacing.sm,
        paddingHorizontal: 4,
        backgroundColor: colors.bgElevated,
        minHeight: 78,
        justifyContent: 'center'
    },
    slotActive: {
        borderColor: colors.brand
    },
    slotHouse: {
        color: colors.text,
        fontSize: 11,
        fontWeight: '700'
    },
    slotDeck: {
        color: colors.textFaint,
        fontSize: 9,
        textAlign: 'center'
    },
    slotEmpty: {
        color: colors.textFaint,
        fontSize: 12,
        fontWeight: '600'
    },
    deckList: {
        maxHeight: 260,
        marginTop: 4
    },
    deckRow: {
        flexDirection: 'row',
        alignItems: 'center',
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.sm,
        marginBottom: 6,
        backgroundColor: colors.bgElevated
    },
    deckRowActive: {
        borderColor: colors.brand
    },
    deckName: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600'
    },
    houseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 3
    },
    deckMeta: {
        color: colors.textFaint,
        fontSize: 10
    }
});
