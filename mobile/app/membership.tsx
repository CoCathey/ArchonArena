import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
    fetchMembershipCatalog,
    fetchMyMembership,
    fetchPatreonStatus,
    unlinkPatreon
} from '../src/api/client';
import type { CapabilityCopy, MembershipTier } from '../src/api/types';
import { TIER_COLORS, TIERS } from '../src/membership/capabilities';
import { currentTier, currentTierName, isAdmin } from '../src/membership/entitlements';
import { connectPatreon } from '../src/membership/patreonLink';
import { canShowPurchaseLinks } from '../src/membership/storefront';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner } from '../src/ui/primitives';

/**
 * ARCHON (N12): Archon+ on the phone.
 *
 * The screen is the same on both platforms except for one thing: whether it may
 * talk about money. That decision is `canShowPurchaseLinks()` and lives in
 * membership/storefront.ts with the reasoning; nothing here re-derives it.
 *
 * On iOS the app describes what membership includes, shows the tier the account
 * is already on, and offers to connect an existing Patreon account. It shows no
 * prices and links to no checkout, because App Store Review Guideline 3.1.1
 * treats either as a call to action toward a non-IAP purchase. What it does
 * instead is what 3.1.3(b) explicitly allows for a multiplatform service:
 * letting a player use a membership they bought elsewhere.
 *
 * The benefit copy is the server's capability catalogue, so the app and the
 * website describe a feature in the same words and a tier change needs no
 * release here. Planned capabilities are shown as planned and never as
 * included — the same rule the pricing page follows.
 */

function TierCard(props: {
    tier: MembershipTier;
    copy: Record<string, CapabilityCopy>;
    isCurrent: boolean;
    admin: boolean;
    showMoney: boolean;
}) {
    const { tier, copy, isCurrent, admin, showMoney } = props;
    const accent = TIER_COLORS[tier.id] ?? colors.textDim;
    const adds = tier.adds ?? [];
    const live = adds.filter((capability) => !copy[capability]?.planned);
    const planned = adds.filter((capability) => copy[capability]?.planned);

    return (
        // Card takes a single style object, not an array.
        <Card style={tier.recommended ? { ...styles.tierCard, borderColor: accent } : styles.tierCard}>
            <View style={styles.tierHead}>
                <Text style={[styles.tierName, { color: accent }]}>{tier.name}</Text>
                {/* `priceUsd` is absent, not zero, where purchase links are
                    not allowed - so this renders nothing rather than "Free"
                    for every tier. */}
                {showMoney && tier.priceUsd !== undefined ? (
                    <Text style={styles.tierPrice}>
                        {tier.priceUsd > 0 ? `$${tier.priceUsd}/mo` : 'Free'}
                    </Text>
                ) : null}
            </View>

            {tier.tagline ? <Text style={styles.tierTagline}>{tier.tagline}</Text> : null}

            {isCurrent ? (
                <View style={[styles.currentPill, { borderColor: accent }]}>
                    <Text style={[styles.currentPillText, { color: accent }]}>
                        {admin ? 'Your admin account includes this' : 'Your current plan'}
                    </Text>
                </View>
            ) : null}

            {tier.rank > 0 ? <Text style={styles.everything}>Everything below, plus:</Text> : null}

            {(tier.includes ?? []).map((line) => (
                <Benefit key={line} label={line} />
            ))}

            {live.map((capability) => (
                <Benefit
                    key={capability}
                    label={copy[capability]?.label ?? capability}
                    learn={copy[capability]?.learn}
                />
            ))}

            {planned.length ? (
                <View style={styles.plannedBlock}>
                    <Text style={styles.plannedHeading}>PLANNED — NOT AVAILABLE YET</Text>
                    {planned.map((capability) => (
                        <Text key={capability} style={styles.plannedItem}>
                            ○ {copy[capability]?.label ?? capability}
                        </Text>
                    ))}
                </View>
            ) : null}

            {/* Checkout is offered only where the store rules allow it AND only
                for a tier that delivers something the tier below does not —
                `purchasable` is computed server-side for exactly that. */}
            {showMoney && (tier.priceUsd ?? 0) > 0 ? (
                tier.purchasable && tier.checkoutUrl ? (
                    <Button
                        title={isCurrent ? 'Manage on Patreon' : `Choose ${tier.name}`}
                        variant={tier.recommended ? 'primary' : 'secondary'}
                        small
                        onPress={() => Linking.openURL(tier.checkoutUrl as string)}
                        style={{ marginTop: spacing.md }}
                    />
                ) : (
                    <Text style={styles.notYet}>
                        {tier.purchasable === false
                            ? 'Not available yet — nothing in this tier is built'
                            : 'Coming soon'}
                    </Text>
                )
            ) : null}
        </Card>
    );
}

function Benefit(props: { label: string; learn?: string }) {
    return (
        <View style={styles.benefit}>
            <Text style={styles.benefitTick}>✓</Text>
            <View style={{ flex: 1 }}>
                <Text style={styles.benefitLabel}>{props.label}</Text>
                {props.learn ? <Text style={styles.benefitLearn}>{props.learn}</Text> : null}
            </View>
        </View>
    );
}

export default function MembershipScreen() {
    const user = useAuthStore((state) => state.user);
    const showMoney = canShowPurchaseLinks();

    const [tiers, setTiers] = useState<MembershipTier[]>([]);
    const [copy, setCopy] = useState<Record<string, CapabilityCopy>>({});
    const [patreonEnabled, setPatreonEnabled] = useState(false);
    const [linked, setLinked] = useState<boolean>(!!user?.patreon);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const tier = currentTier(user);
    const tierName = currentTierName(user) ?? 'Free';
    const admin = isAdmin(user);

    const load = useCallback(async () => {
        try {
            const [catalog, status] = await Promise.all([
                fetchMembershipCatalog(),
                fetchPatreonStatus()
            ]);

            setTiers(catalog.tiers ?? []);
            setCopy(catalog.capabilities ?? {});
            setPatreonEnabled(!!status.enabled);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load membership details.');
        }

        // Only to confirm whether the account is linked — the tier itself comes
        // off the user object, which checkauth keeps current.
        try {
            const mine = await fetchMyMembership();
            setLinked(!!mine.membership?.provider);
        } catch {
            // Not fatal: the screen still lists what membership includes.
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const onConnect = async () => {
        setBusy(true);
        setError(undefined);
        setNotice(undefined);

        const outcome = await connectPatreon();

        setBusy(false);

        if (outcome.status === 'linked') {
            setLinked(true);
            setNotice(
                outcome.tier && outcome.tier !== 'Free'
                    ? `Connected. Your ${outcome.tier} benefits are unlocked.`
                    : 'Patreon account connected.'
            );
            load();
        } else if (outcome.status === 'declined') {
            setError('Patreon did not authorise the link. Nothing on your account changed.');
        } else if (outcome.status === 'unsupported' || outcome.status === 'failed') {
            setError(outcome.message);
        }
        // 'cancelled' is the player closing the sheet — not an error, no message.
    };

    const onDisconnect = async () => {
        setBusy(true);
        setError(undefined);
        setNotice(undefined);

        try {
            await unlinkPatreon();
            setLinked(false);
            setNotice('Patreon account disconnected.');
            load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not disconnect Patreon.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: colors.bg }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }}
        >
            <ErrorBanner message={error} />
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            {/* Status first: the one line a member opens this screen for. */}
            <Card>
                <Text style={styles.sectionHeading}>Your membership</Text>
                <View style={styles.statusRow}>
                    <View
                        style={[
                            styles.tierPill,
                            { borderColor: TIER_COLORS[tier] ?? colors.border }
                        ]}
                    >
                        <Text
                            style={[
                                styles.tierPillText,
                                { color: TIER_COLORS[tier] ?? colors.textDim }
                            ]}
                        >
                            {admin ? `${tierName} · admin` : tierName}
                        </Text>
                    </View>
                    {tier !== TIERS.FREE || admin ? (
                        <Text style={styles.statusHint}>Benefits are unlocked on this device.</Text>
                    ) : null}
                </View>

                {admin ? (
                    <Text style={styles.adminNote}>
                        You are an administrator, so every membership feature is unlocked for your
                        account regardless of subscription.
                    </Text>
                ) : null}

                {patreonEnabled ? (
                    <View style={{ marginTop: spacing.md }}>
                        {linked ? (
                            <>
                                <Text style={styles.hint}>
                                    Your Patreon account is connected. Your tier updates
                                    automatically when your pledge changes.
                                </Text>
                                <Button
                                    title='Disconnect Patreon'
                                    variant='secondary'
                                    small
                                    disabled={busy}
                                    onPress={onDisconnect}
                                    style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
                                />
                            </>
                        ) : (
                            <>
                                <Text style={styles.hint}>
                                    Already an Archon+ member? Connect your Patreon account to
                                    unlock your benefits here. You will sign in to Patreon directly
                                    — Archon Arena never sees your Patreon password.
                                </Text>
                                <Button
                                    title={busy ? 'Connecting…' : 'Connect Patreon'}
                                    variant='primary'
                                    small
                                    loading={busy}
                                    onPress={onConnect}
                                    style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
                                />
                            </>
                        )}
                    </View>
                ) : null}
            </Card>

            <Card>
                <Text style={styles.sectionHeading}>
                    {showMoney
                        ? 'Play free. Upgrade for deeper competitive intelligence.'
                        : 'What Archon+ includes'}
                </Text>
                <Text style={styles.hint}>
                    Playing is free and always will be — unlimited games, deck import, matchmaking,
                    leaderboards and tournaments, with nothing held back. Membership unlocks the
                    tools for players who want to understand their decks, improve their play and
                    read the meta.
                </Text>
                <Text style={[styles.hint, { marginTop: spacing.sm }]}>
                    No membership perk affects Amber, matchmaking, tournament eligibility or any
                    other competitive outcome.
                </Text>
            </Card>

            {tiers.map((entry) => (
                <TierCard
                    admin={admin}
                    copy={copy}
                    isCurrent={entry.id === tier}
                    key={entry.id}
                    showMoney={showMoney}
                    tier={entry}
                />
            ))}

            <Card>
                <Text style={styles.sectionHeading}>Questions</Text>
                <Text style={styles.qa}>Does paying make me stronger in game?</Text>
                <Text style={styles.hint}>
                    No. Every perk is analytics, customisation or convenience. Nothing touches the
                    rules, matchmaking or eligibility.
                </Text>
                <Text style={[styles.qa, { marginTop: spacing.sm }]}>
                    Is there a limit on how much I can play for free?
                </Text>
                <Text style={styles.hint}>No. Games are unlimited on every tier, including free.</Text>
                <Text style={[styles.qa, { marginTop: spacing.sm }]}>What if I cancel?</Text>
                <Text style={styles.hint}>
                    You keep your account, your decks and your whole match record. The premium
                    panels lock again, and unlock immediately if you come back.
                </Text>
            </Card>

            {showMoney ? (
                <Pressable onPress={() => Linking.openURL('https://archonarena.com/membership')}>
                    <Text style={styles.link}>See full details on archonarena.com</Text>
                </Pressable>
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    sectionHeading: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    tierPill: {
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 3
    },
    tierPillText: {
        fontSize: 12,
        fontWeight: '700'
    },
    statusHint: {
        color: colors.textDim,
        fontSize: 12
    },
    adminNote: {
        color: colors.accent,
        fontSize: 12,
        lineHeight: 17,
        marginTop: spacing.sm
    },
    hint: {
        color: colors.textDim,
        fontSize: 12,
        lineHeight: 17
    },
    notice: {
        color: colors.success,
        fontSize: 13
    },
    tierCard: {
        borderWidth: 1,
        borderColor: colors.border
    },
    tierHead: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between'
    },
    tierName: {
        fontSize: 16,
        fontWeight: '800'
    },
    tierPrice: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    tierTagline: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 2,
        marginBottom: spacing.sm
    },
    currentPill: {
        borderWidth: 1,
        borderRadius: radius.sm,
        paddingVertical: 4,
        paddingHorizontal: spacing.sm,
        marginBottom: spacing.sm
    },
    currentPillText: {
        fontSize: 11,
        fontWeight: '600',
        textAlign: 'center'
    },
    everything: {
        color: colors.textFaint,
        fontSize: 11,
        marginBottom: spacing.xs
    },
    benefit: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginBottom: 6
    },
    benefitTick: {
        color: colors.success,
        fontSize: 12,
        marginTop: 1
    },
    benefitLabel: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600'
    },
    benefitLearn: {
        color: colors.textDim,
        fontSize: 11,
        lineHeight: 15
    },
    plannedBlock: {
        marginTop: spacing.sm,
        paddingTop: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border
    },
    plannedHeading: {
        color: colors.textFaint,
        fontSize: 9,
        letterSpacing: 0.6,
        fontWeight: '700',
        marginBottom: 4
    },
    plannedItem: {
        color: colors.textFaint,
        fontSize: 12,
        marginBottom: 2
    },
    notYet: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'center',
        marginTop: spacing.md
    },
    qa: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 2
    },
    link: {
        color: colors.accent,
        fontSize: 13,
        textAlign: 'center',
        paddingVertical: spacing.sm
    }
});
