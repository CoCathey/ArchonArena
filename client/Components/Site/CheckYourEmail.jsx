import React, { useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';

import Panel from './Panel.jsx';
import { useResendActivationMutation } from '../../redux/api';

/**
 * ARCHON: what a player sees between registering and clicking the link in
 * their email.
 *
 * Registration used to say "you can now proceed to login" and send them to a
 * login form that would refuse them - the account is deliberately unverified
 * at that point. This is the honest version of that screen, and it carries the
 * resend, which is the only way out if the mail never arrives.
 *
 * The confirmation text is deliberately unconditional. The resend endpoint
 * answers the same way whether the account exists, is already verified, or is
 * on cooldown, so it has nothing to report back and this must not invent a
 * result it was not told.
 *
 * @param {{ username: string, email?: string }} props
 */
const CheckYourEmail = ({ username, email }) => {
    const { t } = useTranslation();
    const [resendActivation, resendState] = useResendActivationMutation();
    const [resent, setResent] = useState(false);
    const inFlight = useRef(false);

    const onResend = async () => {
        if (inFlight.current) {
            return;
        }
        inFlight.current = true;

        try {
            await resendActivation({ username }).unwrap();
        } catch {
            // Nothing to report: see above. A network failure and a refused
            // resend are indistinguishable to the player either way.
        }

        setResent(true);
        inFlight.current = false;
    };

    return (
        <Panel title={t('Check your email')}>
            <p>
                {email
                    ? t(
                          'We have sent a confirmation link to {{email}}. Click it to finish setting up your account.',
                          { email }
                      )
                    : t(
                          'We have sent you a confirmation link. Click it to finish setting up your account.'
                      )}
            </p>
            <p className='mt-2 text-sm text-muted'>
                {t(
                    'You will not be able to log in until your account is confirmed. The link is valid for 7 days.'
                )}
            </p>
            <div className='mt-3 flex items-center gap-3'>
                <Button
                    type='button'
                    variant='secondary'
                    onClick={onResend}
                    isPending={resendState.isLoading}
                    isDisabled={resent}
                >
                    {t('Send it again')}
                </Button>
                {resent && (
                    <span className='text-sm text-muted'>
                        {t(
                            'If that account still needs confirming, another email is on its way. Check your spam folder too.'
                        )}
                    </span>
                )}
            </div>
        </Panel>
    );
};

CheckYourEmail.displayName = 'CheckYourEmail';

export default CheckYourEmail;
