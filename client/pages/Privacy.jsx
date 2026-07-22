import React from 'react';
import Panel from '../Components/Site/Panel';
import SiteContentOverride from '../Components/Site/SiteContentOverride';

import { Trans, useTranslation } from 'react-i18next';

const Privacy = () => {
    const { t } = useTranslation();

    return (
        // ARCHON: admins can replace this whole page from Site Settings >
        // Site Content; the built-in policy below renders when unset.
        <SiteContentOverride field='privacy' title={t('Privacy Policy')}>
            <div className='min-h-full w-full'>
                <Panel title={t('Privacy Policy')}>
                    <h3>
                        <Trans>Background</Trans>
                    </h3>

                    <p>
                        <Trans i18nKey='privacy.background'>
                            Archon Arena is a fan-run platform for playing KeyForge online. We
                            collect only what the site needs to work and we do not sell or rent your
                            data to anyone. This policy explains what we store, why, who else sees
                            any of it, and how to get rid of it.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>What we store</Trans>
                    </h3>
                    <Trans i18nKey='privacy.whatwestore'>
                        <p>
                            <b>Account data:</b> your username, email address, a securely hashed
                            password (we can never see the password itself), and the IP address used
                            at registration and login (kept for abuse prevention).
                        </p>
                        <p>
                            <b>Game data:</b> the games you play - which decks were used, who
                            played, the result and key counts - plus the ratings computed from them
                            and your position on leaderboards.
                        </p>
                        <p>
                            <b>Decks:</b> decks you import are fetched from the official Master
                            Vault by their public deck code and stored so you can play with them.
                        </p>
                        <p>
                            <b>Optional data you choose to provide:</b> your country and
                            state/province (only if you set them, for regional leaderboards), club
                            memberships, friend connections, and chat messages you send.
                        </p>
                        <p>
                            <b>Linked accounts:</b> if you sign in with or link an external account
                            (such as Keybringer or Patreon), we store the account identifier and
                            email that provider shares with us - never their passwords.
                        </p>
                    </Trans>

                    <h3>
                        <Trans>Why we store it</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='privacy.why'>
                            Usernames identify you to other players. Email is used for account
                            verification and password resets. Game history powers your rating, match
                            history, and tournaments - a competitive site cannot work without a
                            record of results. IP addresses are used solely to fight spam, abuse,
                            and ban evasion. Location, if you provide it, only places you on
                            regional leaderboards.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Who else sees your data</Trans>
                    </h3>
                    <Trans i18nKey='privacy.thirdparties'>
                        <p>
                            <b>Publicly visible:</b> your username, game results, ratings,
                            leaderboard positions, club memberships, and any location you set are
                            visible to other visitors - that is what a competitive ladder is.
                        </p>
                        <p>
                            <b>Decks of KeyForge:</b> to show deck power (SAS) ratings we send the
                            public deck identifier - never anything about you - to
                            decksofkeyforge.com.
                        </p>
                        <p>
                            <b>Identity providers:</b> if you sign in with an external account, that
                            provider knows you logged in here; we receive only your basic identity
                            from them.
                        </p>
                        <p>We use no advertising networks and no third-party analytics trackers.</p>
                    </Trans>

                    <h3>
                        <Trans>Cookies and local storage</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='privacy.cookies'>
                            We use browser local storage to keep you signed in and remember
                            interface preferences, and short-lived cookies strictly for completing
                            external sign-in flows. There are no tracking or advertising cookies.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Retention and deletion</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='privacy.deletion'>
                            Your data is kept while your account exists. You can delete your account
                            from your profile settings at any time, which removes your personal
                            data; anonymized game records may be retained for the integrity of other
                            players&apos; ratings and tournament histories. Backups age out on a
                            rolling basis.
                        </Trans>
                    </p>

                    <h3>
                        <Trans>Contact</Trans>
                    </h3>
                    <p>
                        <Trans i18nKey='privacy.contact'>
                            Questions about your data or this policy? Open an issue on our GitHub
                            repository or contact the site administrator. If this policy changes
                            materially, we will announce it on the site.
                        </Trans>
                    </p>
                </Panel>
            </div>
        </SiteContentOverride>
    );
};

Privacy.displayName = 'Privacy';

export default Privacy;
