import React, { useEffect } from 'react';
import PropTypes from 'prop-types';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from '@heroui/react';
import { useTranslation } from 'react-i18next';

import { accountActions } from '../redux/slices/accountSlice';
import { useLinkPatreonMutation } from '../redux/api';
import AlertPanel from '../Components/Site/AlertPanel';
import ApiStatus from '../Components/Site/ApiStatus';
import { useNavigate } from 'react-router-dom';

/**
 * Where Patreon returns the player after they authorise (or refuse) the link.
 *
 * ARCHON (N12): the `state` Patreon echoes back is posted with the code and
 * checked server-side against a signed cookie, so a code cannot be planted by
 * a third party. `error` is Patreon's own signal that the player declined.
 *
 * ## A link started in the phone app comes back here too
 *
 * Patreon allows one registered redirect URI and it is this website, so the app
 * cannot be sent to directly. The app marks its `state`, this page recognises
 * the marker and forwards the code to the app's deep link, rather than trying
 * to complete a link for a browser that is not signed in - which is what would
 * otherwise happen, since the system browser the app opens carries none of the
 * player's site session.
 *
 * The app is listening for exactly this URL, closes its browser sheet the
 * moment it appears, and does the exchange itself with its own bearer token.
 */
// Must match PatreonService.MOBILE_STATE_PREFIX. Deliberately a literal rather
// than an import: this file is bundled for the browser and the service is not.
const MOBILE_STATE_PREFIX = 'm.';

const Patreon = ({ code, state, error }) => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const [linkPatreon, linkState] = useLinkPatreonMutation();
    const accountLinked = useSelector((reduxState) => reduxState.account.accountLinked);
    const isMobileLink = !!state && state.startsWith(MOBILE_STATE_PREFIX);

    useEffect(() => {
        if (!isMobileLink) {
            return;
        }

        const params = new URLSearchParams();

        if (code) {
            params.set('code', code);
        }

        if (state) {
            params.set('state', state);
        }

        if (error) {
            params.set('error', error);
        }

        // replace, not assign: the player must not be able to come back to a
        // spent authorisation code with the browser's back button.
        window.location.replace(`archonarena://patreon?${params.toString()}`);
    }, [code, error, isMobileLink, state]);

    useEffect(() => {
        if (code && state && !isMobileLink) {
            linkPatreon({ code, state });
        }
    }, [code, isMobileLink, state, linkPatreon]);

    useEffect(() => {
        if (!accountLinked) {
            return;
        }

        toast.success(t('Your Patreon account was linked successfully.'));
        dispatch(accountActions.clearLinkStatus());
        navigate('/profile');
    }, [accountLinked, dispatch, navigate, t]);

    if (isMobileLink) {
        return <AlertPanel type='info' message={t('Returning you to the Archon Arena app…')} />;
    }

    if (error) {
        return (
            <AlertPanel
                type='warning'
                message={t(
                    'Patreon did not authorise the link.  Nothing has changed on your account - you can try again from your profile.'
                )}
            />
        );
    }

    if (!code || !state) {
        return (
            <AlertPanel
                type='error'
                message={t(
                    'This page is not intended to be viewed directly.  Please click on one of the links at the top of the page or your browser back button to return to the site.'
                )}
            />
        );
    }

    const apiState = linkState.isUninitialized
        ? null
        : {
              loading: linkState.isLoading,
              success: linkState.isSuccess && linkState.data?.success,
              message:
                  linkState.isSuccess && linkState.data?.success
                      ? t('Your Patreon account was linked successfully.')
                      : linkState.data?.message || linkState.error?.data?.message
          };

    return (
        <div>
            <ApiStatus state={apiState} />
            {linkState.isLoading && <div>{t('Please wait while we verify your details..')}</div>}
        </div>
    );
};

Patreon.propTypes = {
    code: PropTypes.string,
    error: PropTypes.string,
    state: PropTypes.string
};
Patreon.displayName = 'Patreon';

export default Patreon;
