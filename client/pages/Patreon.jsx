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
 */
const Patreon = ({ code, state, error }) => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const [linkPatreon, linkState] = useLinkPatreonMutation();
    const accountLinked = useSelector((reduxState) => reduxState.account.accountLinked);

    useEffect(() => {
        if (code && state) {
            linkPatreon({ code, state });
        }
    }, [code, state, linkPatreon]);

    useEffect(() => {
        if (!accountLinked) {
            return;
        }

        toast.success(t('Your Patreon account was linked successfully.'));
        dispatch(accountActions.clearLinkStatus());
        navigate('/profile');
    }, [accountLinked, dispatch, navigate, t]);

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
