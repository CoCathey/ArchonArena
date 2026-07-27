import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import SiteContentOverride from '../Components/Site/SiteContentOverride';

/**
 * ARCHON: Terms of Service. Taking public sign-ups needs terms, and the site
 * had none.
 *
 * Deliberately plain-language and short: this is a free, fan-run platform, not
 * a commercial service, and terms nobody reads protect nobody. Like About and
 * Privacy, admins can replace the whole page from Site Settings > Site Content.
 *
 * This is not legal advice and has not been reviewed by a lawyer — it states
 * plainly how the site actually behaves.
 */
const Terms = () => {
    const { t } = useTranslation();

    return (
        <SiteContentOverride field='terms' title={t('Terms of Service')}>
            <div className='min-h-full w-full'>
                <Panel title={t('Terms of Service')}>
                    <p className='text-sm text-muted'>
                        <Trans i18nKey='terms.intro'>
                            Archon Arena is a free, fan-run platform for playing KeyForge online. By
                            creating an account you agree to what follows. If you disagree with any
                            of it, please do not use the site.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Your account</Trans>
                    </h3>
                    <ul>
                        <li>
                            <Trans i18nKey='terms.account.age'>
                                You must be old enough to consent to your data being processed in
                                your country — generally 13, or 16 in much of Europe.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.account.one'>
                                One account per person. Do not share it, and do not use someone
                                else&apos;s.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.account.security'>
                                You are responsible for keeping your password safe. Tell us if you
                                think your account has been accessed by someone else.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.account.delete'>
                                You can delete your account at any time from your profile. See the{' '}
                                <Link href='/privacy' className='text-amber-300 underline'>
                                    Privacy Policy
                                </Link>{' '}
                                for what happens to your data.
                            </Trans>
                        </li>
                    </ul>

                    <h3>
                        <Trans>Fair play</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='terms.fairplay.intro'>
                            The competitive ladder only means anything if results are honest. The
                            following will cost you your rating, and repeated or deliberate abuse
                            will cost you your account:
                        </Trans>
                    </p>
                    <ul>
                        <li>
                            <Trans i18nKey='terms.fairplay.collusion'>
                                Arranging results, throwing games, or farming rating with a second
                                account or a willing opponent.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.fairplay.multi'>
                                Using more than one account to enter the same event or ladder.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.fairplay.exploit'>
                                Exploiting a bug rather than reporting it. Report bugs with the
                                &quot;Report a bug&quot; link — that is genuinely more useful to us.
                            </Trans>
                        </li>
                        <li>
                            <Trans i18nKey='terms.fairplay.automation'>
                                Automating play, or scripting the site in a way that degrades it for
                                everyone else.
                            </Trans>
                        </li>
                    </ul>

                    <h3>
                        <Trans>Conduct</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='terms.conduct'>
                            Be decent to your opponents. Harassment, hate speech, threats,
                            impersonation, and spamming chat or the community pages are not allowed.
                            Moderators may remove content and suspend accounts.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>What we owe you</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='terms.service'>
                            Nothing, formally — the site is provided as-is, free, with no guarantee
                            of uptime, and we may change or discontinue features. In practice we run
                            it because we want it to exist, and we will give notice before anything
                            drastic where we can.
                        </Trans>
                    </p>
                    <p>
                        <Trans i18nKey='terms.liability'>
                            To the extent the law allows, we are not liable for losses arising from
                            using the site.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Intellectual property</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='terms.ip'>
                            KeyForge, its card text and its artwork are the property of their rights
                            holders. Archon Arena is an unofficial, non-commercial fan project with
                            no affiliation with or endorsement by them. Card images and data are
                            used to let people play the game they already own.
                        </Trans>
                    </p>
                    <p>
                        <Trans i18nKey='terms.usercontent'>
                            Content you post — deck names, chat, club and event descriptions — stays
                            yours. You give us permission to display it on the site.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Changes</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='terms.changes'>
                            We may update these terms. Material changes will be announced on the
                            site. Continuing to use Archon Arena after a change means you accept the
                            updated terms.
                        </Trans>
                    </p>
                </Panel>
            </div>
        </SiteContentOverride>
    );
};

Terms.displayName = 'Terms';

export default Terms;
