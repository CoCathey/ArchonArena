import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { SERVER_URL } from '../stores/settingsStore';
import { colors, spacing } from '../theme';

/**
 * ARCHON: privacy policy, terms, and how to reach a human.
 *
 * Three separate App Store requirements land on this one small block:
 *
 *  - **5.1.1(i)** — an app that creates accounts and collects personal data
 *    must make its privacy policy available IN the app. A URL in App Store
 *    Connect alone is not enough; a reviewer looks for the link on the screen.
 *  - **1.2** — an app carrying user-generated content must publish contact
 *    information so users can reach the developer about it. Reporting a message
 *    covers content; this covers everything else.
 *  - **5.1.1** generally — the app records that each account accepted the Terms
 *    at sign-up (Users.TermsAcceptedAt), which is hard to defend if the app
 *    never showed them.
 *
 * These open the website in the system browser, which is exactly what a policy
 * link is expected to do. Note it does not conflict with Guideline 3.1.1: that
 * forbids links to PURCHASING mechanisms, not links to legal documents — see
 * membership/storePolicy.ts for the rules that do apply to money.
 */
const LINKS: { label: string; hint: string; path: string }[] = [
    {
        label: 'Privacy policy',
        hint: 'What we collect, why, and how to have it erased.',
        path: '/privacy'
    },
    { label: 'Terms of service', hint: 'The rules you agreed to at sign-up.', path: '/terms' },
    {
        label: 'About and contact',
        hint: 'Who runs Archon Arena, and how to reach us.',
        path: '/about'
    }
];

export function LegalLinksSection() {
    return (
        <View style={styles.section}>
            <Text style={styles.heading}>Legal and support</Text>

            {LINKS.map((link) => (
                <Pressable
                    key={link.path}
                    onPress={() => Linking.openURL(`${SERVER_URL}${link.path}`)}
                    style={styles.row}
                >
                    <View style={{ flex: 1 }}>
                        <Text style={styles.label}>{link.label}</Text>
                        <Text style={styles.hint}>{link.hint}</Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                </Pressable>
            ))}

            <Text style={styles.disclaimer}>
                Archon Arena is a fan-run, open-source platform. KeyForge is a trademark of Fantasy
                Flight Games / Ghost Galaxy. This app is not affiliated with, endorsed by, or
                sponsored by them.
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    section: {
        marginTop: spacing.md
    },
    heading: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border
    },
    label: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600'
    },
    hint: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 1
    },
    chevron: {
        color: colors.textFaint,
        fontSize: 20,
        paddingLeft: spacing.sm
    },
    disclaimer: {
        color: colors.textFaint,
        fontSize: 10,
        lineHeight: 15,
        marginTop: spacing.md
    }
});

export default LegalLinksSection;
