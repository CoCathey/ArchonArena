import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import SiteContentOverride from '../Components/Site/SiteContentOverride';
import {
    Callout,
    Contents,
    Definitions,
    Lead,
    P,
    ProsePage,
    Section
} from '../Components/Site/Prose';

/**
 * ARCHON: the privacy policy.
 *
 * Rewritten against what the code actually does, not what the site used to do.
 * Since the last version the platform gained push notifications, transactional
 * email, external sign-in, paid events and subscriptions - four of which
 * involve either a new third party or a new category of stored data, and none
 * of which the old policy mentioned. A policy that has fallen behind the
 * product is worse than a short one, because it is confidently wrong.
 *
 * Written to be read. Every section says the specific thing - which column,
 * which third party, what leaves the server - because a privacy policy made of
 * hedged generalities communicates nothing and is usually hiding the answer.
 *
 * Two claims worth keeping honest as the site changes:
 *   - no money is processed here (there is no payment integration at all), and
 *   - deletion anonymises rather than erases, because other players' ratings
 *     and event histories depend on the games having happened.
 *
 * Admins can replace this whole page from Site Settings > Site Content.
 */

const SECTIONS = [
    { id: 'short', title: 'The short version' },
    { id: 'store', title: 'What we store' },
    { id: 'why', title: 'Why' },
    { id: 'public', title: 'What is public' },
    { id: 'third-parties', title: 'Who else sees it' },
    { id: 'email', title: 'Email and notifications' },
    { id: 'money', title: 'Payments' },
    { id: 'cookies', title: 'Cookies and storage' },
    { id: 'retention', title: 'Keeping and deleting' },
    { id: 'children', title: 'Children' },
    { id: 'contact', title: 'Contact' }
];

const Privacy = () => {
    const { t } = useTranslation();

    return (
        // ARCHON: admins can replace this whole page from Site Settings >
        // Site Content; the built-in policy below renders when unset.
        <SiteContentOverride field='privacy' title={t('Privacy Policy')}>
            <ProsePage>
                <Panel title={t('Privacy Policy')}>
                    <div className='pt-2'>
                        <Lead>
                            {t(
                                'Archon Arena is a fan-run platform for playing KeyForge. We store what ' +
                                    'the site needs to work and nothing else. We do not sell or rent ' +
                                    'your data, we run no advertising, and we use no third-party ' +
                                    'analytics or tracking.'
                            )}
                        </Lead>

                        <Contents items={SECTIONS} label={t('On this page')} />

                        <Section id='short' title={t('The short version')}>
                            <Definitions
                                items={[
                                    {
                                        term: t('What we need'),
                                        description: t(
                                            'A username, an email address, and a record of the games you ' +
                                                'play. A competitive site cannot exist without knowing ' +
                                                'who played what and who won.'
                                        )
                                    },
                                    {
                                        term: t('What is public'),
                                        description: t(
                                            'Your username, results, rating and leaderboard position. ' +
                                                'That is what a ladder is.'
                                        )
                                    },
                                    {
                                        term: t('What we never see'),
                                        description: t(
                                            'Your password, and any payment details — no money is ' +
                                                'processed on this site at all.'
                                        )
                                    },
                                    {
                                        term: t('Getting out'),
                                        description: t(
                                            'Delete your account from your profile at any time. Your ' +
                                                'personal details go; the games stay, anonymised.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section id='store' title={t('What we store')}>
                            <Definitions
                                items={[
                                    {
                                        term: t('Account'),
                                        description: t(
                                            'Username, email address, and a password stored only as a ' +
                                                'one-way hash — it cannot be read back, by us or by ' +
                                                'anyone who obtained the database.'
                                        )
                                    },
                                    {
                                        term: t('Sign-in records'),
                                        description: t(
                                            'The IP address you registered from, and the IP address and ' +
                                                'device of each active session, so you can review and ' +
                                                'revoke your own sessions and so bans cannot be trivially ' +
                                                'evaded.'
                                        )
                                    },
                                    {
                                        term: t('Games'),
                                        description: t(
                                            'Who played, which decks, the result, the key counts, the ' +
                                                'length, and a replay of the game. Games you record as ' +
                                                'having been played in person are stored the same way.'
                                        )
                                    },
                                    {
                                        term: t('Ratings'),
                                        description: t(
                                            'Your rating and its full history — every change, what was ' +
                                                'expected, and against whom.'
                                        )
                                    },
                                    {
                                        term: t('Decks'),
                                        description: t(
                                            'Decks you import are fetched from the official Master Vault ' +
                                                'by their public deck code and stored so you can play ' +
                                                'with them.'
                                        )
                                    },
                                    {
                                        term: t('Events'),
                                        description: t(
                                            'Which tournaments you entered, the deck you registered, ' +
                                                'your results, whether an organiser has marked your ' +
                                                'entry fee as paid, and any times you offered for a match.'
                                        )
                                    },
                                    {
                                        term: t('Things you write'),
                                        description: t(
                                            'Chat messages, private messages, club and event ' +
                                                'descriptions, and bug reports you file.'
                                        )
                                    },
                                    {
                                        term: t('Optional details'),
                                        description: t(
                                            'Country and region, if you set them, for regional ' +
                                                'leaderboards. An avatar and background, if you upload ' +
                                                'them. Club memberships and friends.'
                                        )
                                    },
                                    {
                                        term: t('Notification tokens'),
                                        description: t(
                                            'If you enable push notifications, the token your device ' +
                                                'issues so a message can reach it. Turning them off ' +
                                                'removes it.'
                                        )
                                    },
                                    {
                                        term: t('Linked accounts'),
                                        description: t(
                                            'If you sign in with an external account or link Patreon, ' +
                                                'the identifier and email that provider gives us. Never ' +
                                                'their passwords.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section id='why' title={t('Why')}>
                            <Definitions
                                items={[
                                    {
                                        term: t('To identify you'),
                                        description: t(
                                            'Your username is how other players know who they are ' +
                                                'playing.'
                                        )
                                    },
                                    {
                                        term: t('To reach you'),
                                        description: t(
                                            'Email confirms your account, resets your password, and — ' +
                                                'only if you leave them switched on — tells you when you ' +
                                                'have been paired or when someone proposes a time.'
                                        )
                                    },
                                    {
                                        term: t('To rate and rank'),
                                        description: t(
                                            'Ratings, leaderboards, tournament standings and your own ' +
                                                'statistics are all computed from the record of games.'
                                        )
                                    },
                                    {
                                        term: t('To keep it fair'),
                                        description: t(
                                            'IP addresses are used for exactly one thing: fighting spam, ' +
                                                'abuse and ban evasion. They are not used to profile or ' +
                                                'locate you.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section
                            id='public'
                            title={t('What is public')}
                            lead={t(
                                'Some of this is visible to anyone, signed in or not. It is worth ' +
                                    'knowing which parts before you fill them in.'
                            )}
                        >
                            <Definitions
                                items={[
                                    {
                                        term: t('Public'),
                                        description: t(
                                            'Username, avatar, game results and replays, ratings and ' +
                                                'leaderboard position, club memberships, tournament ' +
                                                'entries and standings, and any country or region you set.'
                                        )
                                    },
                                    {
                                        term: t('Not public'),
                                        description: t(
                                            'Your email address, your IP addresses, your sessions, your ' +
                                                'private messages, and your settings.'
                                        )
                                    },
                                    {
                                        term: t('Depends'),
                                        description: t(
                                            'Decklists in an event may be hidden or shown, at the ' +
                                                'organiser’s choice, and the event page says which.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section id='third-parties' title={t('Who else sees it')}>
                            <Definitions
                                items={[
                                    {
                                        term: t('Decks of KeyForge'),
                                        description: t(
                                            'To show deck power (SAS) we send the public deck identifier ' +
                                                '— and nothing about you — to decksofkeyforge.com.'
                                        )
                                    },
                                    {
                                        term: t('Master Vault'),
                                        description: t(
                                            'Deck imports are fetched from the official service by deck ' +
                                                'code.'
                                        )
                                    },
                                    {
                                        term: t('Email provider'),
                                        description: t(
                                            'Messages we send you are delivered through an email service, ' +
                                                'which necessarily handles your address and the contents ' +
                                                'of the message.'
                                        )
                                    },
                                    {
                                        term: t('Push service'),
                                        description: t(
                                            'If push notifications are on, notification text is passed ' +
                                                'to the platform push service to reach your device.'
                                        )
                                    },
                                    {
                                        term: t('Sign-in providers'),
                                        description: t(
                                            'If you sign in with an external account, that provider knows ' +
                                                'you signed in here. We receive only basic identity from ' +
                                                'them.'
                                        )
                                    },
                                    {
                                        term: t('Patreon'),
                                        description: t(
                                            'Only if you link it, to check which tier you support at.'
                                        )
                                    }
                                ]}
                            />
                            <Callout>
                                {t(
                                    'No advertising networks. No third-party analytics. No tracking ' +
                                        'pixels. Nothing on this site is trying to work out who you are ' +
                                        'somewhere else.'
                                )}
                            </Callout>
                        </Section>

                        <Section id='email' title={t('Email and notifications')}>
                            <P>
                                {t(
                                    'Some email is unavoidable: confirming your address, and resetting ' +
                                        'your password. Everything else is a notification you can turn ' +
                                        'off — pairings, event start, scheduling, round deadlines, friend ' +
                                        'requests, club invitations, in-person game confirmations, and ' +
                                        'moderation notices about your own account.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Each category can be switched on or off independently, per channel, ' +
                                        'in your profile. We send no marketing email.'
                                )}
                            </P>
                        </Section>

                        <Section id='money' title={t('Payments')}>
                            <P>
                                {t(
                                    'No payment is processed by this site. There is no card form here ' +
                                        'and no payment integration in the software.'
                                )}
                            </P>
                            <Definitions
                                items={[
                                    {
                                        term: t('Event entry fees'),
                                        description: t(
                                            'Arranged directly between you and the organiser, by whatever ' +
                                                'method they publish. All the site stores is a tick ' +
                                                'saying the organiser considers you paid.'
                                        )
                                    },
                                    {
                                        term: t('Archon+ subscriptions'),
                                        description: t(
                                            'Handled entirely by Patreon, under Patreon’s terms and ' +
                                                'privacy policy. We learn which tier you are on, and ' +
                                                'nothing about your payment method.'
                                        )
                                    },
                                    {
                                        term: t('Prize pools'),
                                        description: t(
                                            'Recorded and displayed by the site, paid out by the ' +
                                                'organiser. Money never passes through us.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section id='cookies' title={t('Cookies and storage')}>
                            <P>
                                {t(
                                    'Browser local storage keeps you signed in and remembers interface ' +
                                        'preferences. Short-lived cookies are used strictly to complete ' +
                                        'an external sign-in. There are no tracking or advertising ' +
                                        'cookies, so there is no consent banner to click through.'
                                )}
                            </P>
                        </Section>

                        <Section id='retention' title={t('Keeping and deleting')}>
                            <P>
                                {t(
                                    'Your data is kept while your account exists. You can delete your ' +
                                        'account from your profile at any time; it asks for your password ' +
                                        'first, because it cannot be undone.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Deleting replaces your username and email with anonymous ' +
                                        'placeholders and removes your avatar and personal settings. The ' +
                                        'games themselves remain, without your name on them.'
                                )}
                            </P>
                            <Callout>
                                {t(
                                    'That last part is deliberate. Every game had an opponent whose ' +
                                        'rating moved because of it, and may have been part of a ' +
                                        'tournament with a standing. Erasing the games would silently ' +
                                        'rewrite other people’s records, so the result survives and your ' +
                                        'identity does not.'
                                )}
                            </Callout>
                            <P>
                                {t(
                                    'Backups exist and age out on a rolling basis, so a deleted account ' +
                                        'may persist in an encrypted backup for a short period before ' +
                                        'that copy expires.'
                                )}
                            </P>
                        </Section>

                        <Section id='children' title={t('Children')}>
                            <P>
                                {t(
                                    'You need to be old enough to consent to your data being processed ' +
                                        'where you live — generally 13, and 16 in much of Europe. If we ' +
                                        'learn an account belongs to someone younger, we will remove it.'
                                )}
                            </P>
                        </Section>

                        <Section id='contact' title={t('Contact')}>
                            <P>
                                {t(
                                    'Questions about your data, or a request to see or correct it: open ' +
                                        'an issue on our GitHub repository, or contact the site ' +
                                        'administrator. If this policy changes in a way that matters, we ' +
                                        'will say so on the site rather than changing it quietly.'
                                )}
                            </P>
                            <P>
                                <Link className='text-accent hover:underline' href='/terms'>
                                    {t('Terms of Service')}
                                </Link>
                            </P>
                        </Section>
                    </div>
                </Panel>
            </ProsePage>
        </SiteContentOverride>
    );
};

Privacy.displayName = 'Privacy';

export default Privacy;
