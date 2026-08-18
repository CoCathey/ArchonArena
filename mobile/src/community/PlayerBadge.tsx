import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { create } from 'zustand';
import { fetchBadges, type PlayerBadgeData } from '../api/community';
import { TIER_COLORS, TIERS } from '../membership/capabilities';
import { colors, radius } from '../theme';

/**
 * ARCHON (N12/N20/F9): the pill next to a name.
 *
 * The website puts one beside every username — staff role, paid tier, a New
 * pill on a fresh account, a BOT pill on a practice bot. The app rendered bare
 * names everywhere, so a Vault Master and a bot looked identical in the lobby.
 *
 * Badges are a batched public lookup and the server treats them as decoration
 * it may fail to serve. Nothing here is ever awaited before names render: the
 * store fills in and the pills appear.
 */

interface BadgeStoreState {
    badges: Record<string, PlayerBadgeData>;
    /** Names already asked about — including ones that came back with no badge. */
    asked: Set<string>;
    /** Queue a page of names for one batched lookup. */
    ensure: (usernames: (string | undefined)[]) => void;
}

let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export const useBadgeStore = create<BadgeStoreState>((set, get) => ({
    badges: {},
    asked: new Set<string>(),
    ensure: (usernames) => {
        const { asked } = get();
        const fresh = usernames
            .filter((name): name is string => !!name)
            .map((name) => name.toLowerCase())
            .filter((name) => !asked.has(name) && !pending.includes(name));

        if (fresh.length === 0) {
            return;
        }

        pending = [...pending, ...fresh];

        // Coalesce a screenful of rows into one request. Each row calls
        // ensure() as it mounts, and a list of fifty names is one lookup, not
        // fifty.
        if (flushTimer) {
            return;
        }

        flushTimer = setTimeout(async () => {
            const wanted = pending;
            pending = [];
            flushTimer = undefined;

            // Marked asked BEFORE the call: a name the server has no badge for
            // must not be re-requested on every re-render.
            set((state) => {
                const next = new Set(state.asked);
                for (const name of wanted) {
                    next.add(name);
                }

                return { asked: next };
            });

            try {
                const result = await fetchBadges(wanted);
                const badges = result.badges ?? {};
                if (Object.keys(badges).length === 0) {
                    return;
                }

                set((state) => {
                    const merged = { ...state.badges };
                    for (const [name, badge] of Object.entries(badges)) {
                        merged[name.toLowerCase()] = badge;
                    }

                    return { badges: merged };
                });
            } catch {
                // Decoration. A page of names with no pills is a page that
                // still works.
            }
        }, 120);
    }
}));

/** Staff roles the server may report, with the colour the site gives them. */
const ROLE_COLORS: Record<string, string> = {
    admin: '#e5484d',
    supporter: '#34d399',
    contributor: '#4f8ef7',
    winner: '#f7c548',
    previouswinner: '#c9a227'
};

function pillsFor(badge?: PlayerBadgeData): { label: string; color: string }[] {
    if (!badge) {
        return [];
    }

    const pills: { label: string; color: string }[] = [];

    if (badge.isBot) {
        pills.push({ label: 'BOT', color: colors.textFaint });
    }
    if (badge.role && badge.role !== 'user') {
        pills.push({
            label: badge.role,
            color: ROLE_COLORS[badge.role.toLowerCase()] ?? colors.accent
        });
    }
    if (badge.tierName && badge.tier && badge.tier !== TIERS.FREE) {
        pills.push({ label: badge.tierName, color: TIER_COLORS[badge.tier] ?? colors.brand });
    }
    if (badge.isNew) {
        pills.push({ label: 'new', color: colors.success });
    }

    return pills;
}

/**
 * A player's name with its badges, tapping through to their profile.
 *
 * `linked` exists because the same name is sometimes already inside a
 * pressable row — nesting one press target in another gives the phone two
 * plausible things to do with a tap and it picks the wrong one.
 */
export default function PlayerName(props: {
    username?: string;
    style?: ViewStyle;
    textStyle?: object;
    linked?: boolean;
    compact?: boolean;
}) {
    const { username } = props;
    const ensure = useBadgeStore((state) => state.ensure);
    const badge = useBadgeStore((state) =>
        username ? state.badges[username.toLowerCase()] : undefined
    );

    useEffect(() => {
        if (username) {
            ensure([username]);
        }
    }, [ensure, username]);

    if (!username) {
        return null;
    }

    const pills = pillsFor(badge);
    const body = (
        <View style={[styles.row, props.style]}>
            <Text
                style={[styles.name, props.linked !== false && styles.linkedName, props.textStyle]}
                numberOfLines={1}
            >
                {username}
            </Text>
            {props.compact
                ? null
                : pills.map((pill) => (
                      <View
                          key={pill.label}
                          style={[styles.pill, { borderColor: pill.color }]}
                      >
                          <Text style={[styles.pillText, { color: pill.color }]}>
                              {pill.label}
                          </Text>
                      </View>
                  ))}
        </View>
    );

    if (props.linked === false) {
        return body;
    }

    return (
        <Pressable
            onPress={() => router.push(`/players/${encodeURIComponent(username)}`)}
            hitSlop={6}
        >
            {body}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        flexShrink: 1
    },
    name: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
        flexShrink: 1
    },
    linkedName: {
        color: colors.text
    },
    pill: {
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 5,
        paddingVertical: 1
    },
    pillText: {
        fontSize: 9,
        fontWeight: '800',
        textTransform: 'uppercase',
        letterSpacing: 0.3
    }
});
