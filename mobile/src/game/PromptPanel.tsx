import React, { useEffect } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage } from '../api/types';
import { colors, radius, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';
import { CARD_ASPECT, cardImageUrl } from './cardImages';
import { LogLine } from './LogMessages';
import NameLookup, { useCardNames, useTraitNames } from './NameLookup';
import { useCardsStore } from '../stores/cardsStore';
import { formatButtonText, formatPromptText } from './promptText';
import type { CardSummary, PlayerState, PromptButton, PromptControl } from './types';

const HOUSE_NAMES = new Set([
    'brobnar',
    'dis',
    'ekwidon',
    'geistoid',
    'logos',
    'mars',
    'ouboros',
    'redemption',
    'sanctum',
    'saurian',
    'shadows',
    'skyborn',
    'staralliance',
    'unfathomable',
    'untamed'
]);

/** How many of the latest log lines to surface while waiting on the opponent. */
const WAITING_FEED_LINES = 5;

/**
 * A prompt that asks the player to NAME something rather than pick it off the
 * board: `card-name` (Etan's Jar, Dark Discovery, Varghast's Vengeance) and
 * `trait-name` (Harvest Time, Congregate).
 *
 * These arrive as a control with no buttons attached, so before this the app
 * showed a title and nothing to answer it with — the turn could not proceed
 * from either side. The answer goes back the way the web client sends it
 * (`ActivePlayerPrompt.onControlSelected`): the control's own command, with
 * the typed name in the argument slot.
 */
function NameControl(props: {
    control: PromptControl;
    onAnswer: (control: PromptControl, value: string) => void;
}) {
    const isTrait = props.control.type === 'trait-name';
    const cardNames = useCardNames();
    const traitNames = useTraitNames();
    const loading = useCardsStore((state) => state.loading);
    const loadCards = useCardsStore((state) => state.load);

    // The dictionary is cached for the session, so this is a no-op in a game
    // reached through the deck list. It is not a no-op for a game joined from
    // a push notification, which is exactly when a player is least able to go
    // and open some other screen to warm the cache.
    useEffect(() => {
        loadCards();
    }, [loadCards]);

    return (
        <NameLookup
            values={isTrait ? traitNames : cardNames}
            placeholder={isTrait ? 'Search traits' : 'Search cards'}
            loading={loading}
            onSelect={(value) => props.onAnswer(props.control, value)}
        />
    );
}

function CardThumb(props: {
    card: CardSummary;
    width: number;
    onPress?: (card: CardSummary) => void;
}) {
    const url = cardImageUrl(props.card);
    if (!url) {
        return null;
    }
    return (
        <Pressable
            onPress={props.onPress ? () => props.onPress?.(props.card) : undefined}
            disabled={!props.onPress}
            hitSlop={4}
            accessibilityRole='image'
            accessibilityLabel={props.card.name ?? 'Card'}
        >
            <Image
                source={{ uri: url }}
                style={{
                    width: props.width,
                    height: Math.round(props.width * CARD_ASPECT),
                    borderRadius: 3
                }}
                contentFit='cover'
                cachePolicy='disk'
            />
        </Pressable>
    );
}

/**
 * "Do this because of this" context for effect resolution: the card whose
 * ability is being resolved (controls[].source) plus what it is aimed at
 * (controls[].targets). Mirrors the web client's AbilityTargeting widget,
 * with an explicit label so multi-trigger turns stay readable.
 */
function EffectContext(props: {
    source: CardSummary;
    targets: CardSummary[];
    onCardPress?: (card: CardSummary) => void;
}) {
    const sourceName = props.source.name ?? props.source.label;
    return (
        <View style={styles.contextBlock}>
            <View style={styles.contextRow}>
                <CardThumb card={props.source} width={30} onPress={props.onCardPress} />
                <Text style={styles.contextText} numberOfLines={2}>
                    <Text style={styles.contextDim}>because of </Text>
                    <Text
                        style={styles.contextName}
                        onPress={
                            props.onCardPress ? () => props.onCardPress?.(props.source) : undefined
                        }
                        suppressHighlighting
                    >
                        {String(sourceName ?? 'a card effect')}
                    </Text>
                </Text>
                {props.targets.length > 0 ? (
                    <>
                        <Text style={styles.contextArrow}>→</Text>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.contextTargets}
                            style={{ flexGrow: 0 }}
                        >
                            {props.targets.map((target, index) => (
                                <CardThumb
                                    key={`${target.uuid ?? target.id ?? index}`}
                                    card={target}
                                    width={30}
                                    onPress={props.onCardPress}
                                />
                            ))}
                        </ScrollView>
                    </>
                ) : null}
            </View>
        </View>
    );
}

/**
 * The active-player prompt: current prompt title plus its buttons. House
 * choices arrive as regular buttons carrying an `icon`, and house-select
 * targeting controls reuse the buttons with house names. While the opponent
 * is acting (a prompt with no buttons or selections for us), the latest game
 * log lines are shown inline so their plays can be followed without opening
 * the log sheet.
 */
export default function PromptPanel(props: {
    me?: PlayerState;
    onButton: (button: PromptButton) => void;
    messages?: ChatMessage[];
    onOpenLog?: () => void;
    onCardPress?: (card: CardSummary) => void;
}) {
    // A named answer travels as a button whose `arg` is the name — the same
    // shape `onButton` already sends, so the socket call has one caller.
    const answerNameControl = (control: PromptControl, value: string) =>
        props.onButton({
            command: typeof control.command === 'string' ? control.command : 'menuButton',
            arg: value,
            uuid: typeof control.uuid === 'string' ? control.uuid : undefined,
            method: typeof control.method === 'string' ? control.method : undefined
        });

    const { me } = props;
    if (!me) {
        return null;
    }

    const buttons = me.buttons ?? [];
    const controls = me.controls ?? [];
    const hasHouseSelectControl = controls.some((control) => control.type === 'house-select');
    // House buttons show as an icon grid: either explicit icon buttons
    // (Choose Active House) or, for a house-select targeting control, the
    // house-named buttons. Everything else — Done / Cancel / Autoresolve —
    // renders as plain buttons so the user is never left without a way out.
    const iconButtons = buttons.filter((button) => button.icon);
    const houseButtons =
        iconButtons.length > 0
            ? iconButtons
            : hasHouseSelectControl
            ? buttons.filter((button) => HOUSE_NAMES.has(String(button.text ?? '').toLowerCase()))
            : [];
    const houseSet = new Set(houseButtons);
    const plainButtons = buttons.filter((button) => !houseSet.has(button));

    // The card whose effect is being resolved — the web client uses
    // controls[0].source both for display and to fill {{card}} in titles.
    const contextControl = controls.find((control) => control.source);
    const sourceCard = contextControl?.source;
    const targets = Array.isArray(contextControl?.targets) ? contextControl.targets : [];

    const title = formatPromptText(me.menuTitle, sourceCard);
    const promptTitle = formatPromptText(me.promptTitle, sourceCard);

    // Controls the player answers by typing rather than by tapping the board.
    const nameControls = controls.filter(
        (control) => control.type === 'card-name' || control.type === 'trait-name'
    );

    // A prompt with nothing for us to do means the opponent is acting; show
    // the tail of the game log so each play is easy to follow.
    const waiting =
        buttons.length === 0 && controls.length === 0 && !me.selectCard && !me.selectOrder;
    const feed = waiting ? (props.messages ?? []).slice(-WAITING_FEED_LINES) : [];

    if (
        !title &&
        buttons.length === 0 &&
        nameControls.length === 0 &&
        feed.length === 0 &&
        !sourceCard
    ) {
        return null;
    }

    return (
        <View style={styles.container}>
            {promptTitle && promptTitle !== title ? (
                <Text style={styles.promptTitle}>{promptTitle}</Text>
            ) : null}
            {title ? <Text style={styles.title}>{title}</Text> : null}

            {sourceCard ? (
                <EffectContext
                    source={sourceCard}
                    targets={targets}
                    onCardPress={props.onCardPress}
                />
            ) : null}

            {nameControls.map((control, index) => (
                <NameControl
                    key={`${control.type}-${index}`}
                    control={control}
                    onAnswer={answerNameControl}
                />
            ))}

            {houseButtons.length > 0 ? (
                <View style={styles.houseRow}>
                    {houseButtons.map((button, index) => (
                        <Pressable
                            key={`${String(button.arg)}-${index}`}
                            onPress={() => props.onButton(button)}
                            disabled={!!button.disabled}
                            accessibilityRole='button'
                            accessibilityState={{ disabled: !!button.disabled }}
                            style={({ pressed }) => [
                                styles.houseButton,
                                pressed && { opacity: 0.7 },
                                button.disabled && { opacity: 0.35 }
                            ]}
                        >
                            <HouseIcon
                                house={String(button.icon ?? button.text ?? '')}
                                size={40}
                            />
                            <Text style={styles.houseLabel}>
                                {String(button.text ?? button.icon ?? '')}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            {plainButtons.length > 0 ? (
                <View style={styles.buttonRow}>
                    {plainButtons.map((button, index) => {
                        const label = formatButtonText(button);
                        return (
                            <Pressable
                                key={`${String(button.arg)}-${index}`}
                                onPress={() => props.onButton(button)}
                                onLongPress={
                                    button.card && props.onCardPress
                                        ? () => props.onCardPress?.(button.card as CardSummary)
                                        : undefined
                                }
                                delayLongPress={400}
                                disabled={!!button.disabled}
                                accessibilityRole='button'
                                accessibilityLabel={label}
                                accessibilityState={{ disabled: !!button.disabled }}
                                style={({ pressed }) => [
                                    styles.promptButton,
                                    pressed && { opacity: 0.7 },
                                    button.disabled && { opacity: 0.35 }
                                ]}
                            >
                                {button.card ? (
                                    <CardThumb card={button.card} width={22} />
                                ) : null}
                                <Text style={styles.promptButtonText}>{label}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}

            {feed.length > 0 ? (
                <Pressable onPress={props.onOpenLog} style={styles.feed}>
                    {feed.map((message, index) => (
                        <View
                            key={`feed-${index}`}
                            style={{ opacity: 0.55 + (0.45 * (index + 1)) / feed.length }}
                        >
                            <LogLine
                                message={message}
                                onCardPress={(card) => props.onCardPress?.(card)}
                            />
                        </View>
                    ))}
                    <Text style={styles.feedHint}>Tap for full log</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: 'rgba(18, 24, 38, 0.96)',
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        marginHorizontal: spacing.sm,
        marginVertical: 6,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm
    },
    promptTitle: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 2,
        textTransform: 'uppercase',
        letterSpacing: 0.4
    },
    title: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
        marginBottom: 6
    },
    contextBlock: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.sm,
        backgroundColor: 'rgba(10, 14, 24, 0.6)',
        paddingHorizontal: spacing.sm,
        paddingVertical: 5,
        marginBottom: 8
    },
    contextRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    contextText: {
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 16
    },
    contextDim: {
        color: colors.textDim,
        fontSize: 12
    },
    contextName: {
        color: '#5fd4a0',
        fontWeight: '700',
        fontSize: 12
    },
    contextArrow: {
        color: colors.textFaint,
        fontSize: 13
    },
    contextTargets: {
        flexDirection: 'row',
        gap: 4,
        alignItems: 'center'
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingHorizontal: 2
    },
    promptButton: {
        backgroundColor: colors.brand,
        borderRadius: radius.sm,
        paddingHorizontal: 16,
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7
    },
    promptButtonText: {
        color: '#161006',
        fontWeight: '700',
        fontSize: 15,
        flexShrink: 1
    },
    houseRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.lg,
        flexWrap: 'wrap'
    },
    houseButton: {
        alignItems: 'center',
        gap: 4
    },
    houseLabel: {
        color: colors.textDim,
        fontSize: 11,
        fontWeight: '600',
        textTransform: 'capitalize'
    },
    feed: {
        marginTop: 6,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: 4
    },
    feedHint: {
        color: colors.textFaint,
        fontSize: 10,
        textAlign: 'center',
        paddingTop: 4
    }
});
