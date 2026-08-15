import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import SiteContentOverride from '../Components/Site/SiteContentOverride';
import {
    Bullets,
    Callout,
    Contents,
    Definitions,
    Lead,
    P,
    ProsePage,
    Section
} from '../Components/Site/Prose';

/**
 * ARCHON: Terms of Service.
 *
 * Deliberately plain-language: this is a free, fan-run platform, and terms
 * nobody reads protect nobody. That principle has not changed. What has changed
 * is the surface they need to cover - the site now has paid events with prize
 * pools it does not handle, subscriptions billed by a third party, organisers
 * and judges with authority over other players, and user content in more places
 * than chat. Terms that only discuss casual games leave every one of those
 * undefined at the moment somebody needs them defined.
 *
 * The additions are mostly about who is responsible for what: entry fees are
 * between a player and an organiser, subscriptions are between a player and
 * Patreon, and the site is neither party. Saying so before a dispute is much
 * cheaper than saying it during one.
 *
 * This is not legal advice and has not been reviewed by a lawyer. It states
 * plainly how the site actually behaves.
 *
 * Admins can replace this whole page from Site Settings > Site Content.
 */

const SECTIONS = [
    { id: 'account', title: 'Your account' },
    { id: 'fairplay', title: 'Fair play' },
    { id: 'conduct', title: 'Conduct' },
    { id: 'events', title: 'Tournaments' },
    { id: 'money', title: 'Money' },
    { id: 'membership', title: 'Archon+' },
    { id: 'content', title: 'What you post' },
    { id: 'enforcement', title: 'Enforcement' },
    { id: 'service', title: 'What we owe you' },
    { id: 'ip', title: 'Intellectual property' },
    { id: 'changes', title: 'Changes' }
];

const Terms = () => {
    const { t } = useTranslation();

    return (
        <SiteContentOverride field='terms' title={t('Terms of Service')}>
            <ProsePage>
                <Panel title={t('Terms of Service')}>
                    <div className='pt-2'>
                        <Lead>
                            {t(
                                'Archon Arena is a free, fan-run platform for playing KeyForge. By ' +
                                    'creating an account you agree to what follows. It is written to be ' +
                                    'read — if you disagree with any of it, please do not use the site.'
                            )}
                        </Lead>

                        <Contents items={SECTIONS} label={t('On this page')} />

                        <Section id='account' title={t('Your account')}>
                            <Bullets
                                items={[
                                    t(
                                        'You must be old enough to consent to your data being processed ' +
                                            'where you live — generally 13, or 16 in much of Europe.'
                                    ),
                                    t(
                                        'One account per person. Do not share yours, and do not use ' +
                                            'anyone else’s.'
                                    ),
                                    t(
                                        'Keep your password safe, and tell us if you think someone else ' +
                                            'has got into your account.'
                                    ),
                                    t(
                                        'You may need to confirm your email address before you can play.'
                                    )
                                ]}
                            />
                            <P>
                                {t(
                                    'You can delete your account at any time from your profile. The '
                                )}
                                <Link className='text-accent hover:underline' href='/privacy'>
                                    {t('Privacy Policy')}
                                </Link>
                                {t(' explains exactly what happens to your data when you do.')}
                            </P>
                        </Section>

                        <Section
                            id='fairplay'
                            title={t('Fair play')}
                            lead={t(
                                'A ladder only means something if the results are honest. These will ' +
                                    'cost you your rating, and doing them deliberately or repeatedly ' +
                                    'will cost you your account.'
                            )}
                        >
                            <Bullets
                                items={[
                                    t(
                                        'Arranging results, throwing games, or farming rating with a ' +
                                            'second account or a willing opponent.'
                                    ),
                                    t(
                                        'Using more than one account in the same event or on the same ' +
                                            'ladder.'
                                    ),
                                    t(
                                        'Exploiting a bug instead of reporting it. Reporting it is ' +
                                            'genuinely more useful to us, and we would rather fix it.'
                                    ),
                                    t(
                                        'Automating play, or scripting the site in a way that degrades ' +
                                            'it for everyone else.'
                                    ),
                                    t(
                                        'Abandoning rated games or event matches to avoid a loss. ' +
                                            'Concede instead — it takes one click and it is not held ' +
                                            'against you.'
                                    ),
                                    t(
                                        'Reporting a result you know to be false, in an event or ' +
                                            'in an in-person game.'
                                    )
                                ]}
                            />
                        </Section>

                        <Section id='conduct' title={t('Conduct')}>
                            <P>
                                {t(
                                    'Be decent to your opponents. Harassment, hate speech, threats, ' +
                                        'impersonation, and spamming chat or the community pages are not ' +
                                        'allowed anywhere on the site — including deck names, club ' +
                                        'descriptions and event descriptions, which are as public as a ' +
                                        'chat message.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'If someone is making the game unpleasant, block them, and report ' +
                                        'them if it warrants it. Reports are read.'
                                )}
                            </P>
                        </Section>

                        <Section
                            id='events'
                            title={t('Tournaments')}
                            lead={t(
                                'Anyone can run an event here, which means most events are run by ' +
                                    'another player rather than by us.'
                            )}
                        >
                            <Definitions
                                items={[
                                    {
                                        term: t('Organisers decide the rules'),
                                        description: t(
                                            'Format, allowed sets, deck registration, timings, prizes ' +
                                                'and any entry fee are theirs to set, and are shown on ' +
                                                'the event page before you register.'
                                        )
                                    },
                                    {
                                        term: t('Organisers and judges have authority'),
                                        description: t(
                                            'Within their event they may correct results, resolve ' +
                                                'disputes, and remove players — including for not paying ' +
                                                'an entry fee or not registering a legal deck by the ' +
                                                'deadline.'
                                        )
                                    },
                                    {
                                        term: t('Their authority stops there'),
                                        description: t(
                                            'It applies to their own event. It is not a moderation role ' +
                                                'on the wider site.'
                                        )
                                    },
                                    {
                                        term: t('Run yours in good faith'),
                                        description: t(
                                            'If you organise, announce the rules up front, apply them ' +
                                                'evenly, and pay out what you advertised. Events that ' +
                                                'fall short of that can be removed, and their organisers ' +
                                                'stopped from running more.'
                                        )
                                    }
                                ]}
                            />
                            <Callout tone='warn'>
                                {t(
                                    'We are not a party to an event you enter. If an organiser does not ' +
                                        'deliver a prize they promised, that is between you and them — ' +
                                        'tell us, because we will act on the account, but we cannot pay ' +
                                        'the prize.'
                                )}
                            </Callout>
                        </Section>

                        <Section id='money' title={t('Money')}>
                            <P>
                                {t(
                                    'No payment is processed by this site. There is no payment ' +
                                        'integration in the software at all.'
                                )}
                            </P>
                            <Bullets
                                items={[
                                    t(
                                        'Entry fees and prizes are arranged directly between players and ' +
                                            'organisers. The site only records whether an organiser has ' +
                                            'marked an entry as paid.'
                                    ),
                                    t(
                                        'Whether a paid event is lawful where it is run — and any tax on ' +
                                            'its prizes — is the organiser’s responsibility, not ours.'
                                    ),
                                    t(
                                        'Do not use event payments to move money for any other purpose.'
                                    )
                                ]}
                            />
                        </Section>

                        <Section id='membership' title={t('Archon+')}>
                            <P>
                                {t(
                                    'Archon+ is optional. The game, rated play, tournaments and the ' +
                                        'community are free and stay free; the subscription pays for ' +
                                        'servers and unlocks additional analysis tools.'
                                )}
                            </P>
                            <Bullets
                                items={[
                                    t(
                                        'Billing is handled entirely by Patreon, under their terms. ' +
                                            'Cancel there, and access continues to the end of the period ' +
                                            'you have paid for.'
                                    ),
                                    t(
                                        'What each tier includes may change as tools are added or ' +
                                            'reworked. If something is removed from a tier, we will say ' +
                                            'so.'
                                    ),
                                    t(
                                        'A subscription buys tools and support. It buys no advantage in ' +
                                            'a game and no standing in an event.'
                                    )
                                ]}
                            />
                        </Section>

                        <Section id='content' title={t('What you post')}>
                            <P>
                                {t(
                                    'Content you create — deck names, chat, club and event descriptions, ' +
                                        'articles, bug reports — stays yours. You give us permission to ' +
                                        'store and display it on the site so the site can work.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Do not post anything you do not have the right to post. We may ' +
                                        'remove content that breaks these terms, and content in a public ' +
                                        'game record may remain visible in that record.'
                                )}
                            </P>
                        </Section>

                        <Section id='enforcement' title={t('Enforcement')}>
                            <P>
                                {t(
                                    'Where we can, the response fits what happened: a word first, then a ' +
                                        'rating correction or content removal, then a suspension, and a ' +
                                        'permanent ban for deliberate or repeated abuse. Cheating in a ' +
                                        'rated game or an event skips the earlier steps.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'If you think a moderation decision was wrong, say so — we would ' +
                                        'rather hear it than not.'
                                )}
                            </P>
                        </Section>

                        <Section id='service' title={t('What we owe you')}>
                            <P>
                                {t(
                                    'Formally, nothing: the site is provided as-is and free, with no ' +
                                        'guarantee of uptime, and features may change or disappear. To ' +
                                        'the extent the law allows, we are not liable for losses arising ' +
                                        'from using it.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'In practice we run it because we want it to exist. We will give ' +
                                        'notice before anything drastic where we can, and we would ' +
                                        'rather fix a problem than stand behind that paragraph.'
                                )}
                            </P>
                        </Section>

                        <Section id='ip' title={t('Intellectual property')}>
                            <P>
                                {t(
                                    'KeyForge, its card text and its artwork belong to their rights ' +
                                        'holders. Archon Arena is an unofficial, non-commercial fan ' +
                                        'project with no affiliation with or endorsement by them. Card ' +
                                        'images and data are used so that people can play a game they ' +
                                        'already own.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'If you hold those rights and want something changed, please get in ' +
                                        'touch — we will.'
                                )}
                            </P>
                        </Section>

                        <Section id='changes' title={t('Changes')}>
                            <P>
                                {t(
                                    'We may update these terms. Changes that matter will be announced on ' +
                                        'the site rather than slipped in. Continuing to use Archon Arena ' +
                                        'after a change means you accept the updated terms.'
                                )}
                            </P>
                        </Section>
                    </div>
                </Panel>
            </ProsePage>
        </SiteContentOverride>
    );
};

Terms.displayName = 'Terms';

export default Terms;
