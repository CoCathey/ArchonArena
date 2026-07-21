import React, { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { toast } from '@heroui/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Login from '../Components/Login';
import Panel from '../Components/Site/Panel';
import ApiStatus from '../Components/Site/ApiStatus';
import SsoButton from '../Components/Site/SsoButton';
import { useLoginAccountMutation } from '../redux/api';
import { setAuthTokens } from '../redux/slices/authSlice';
import { lobbyAuthenticateRequested, lobbyConnectRequested } from '../redux/socketActions';

const LoginContainer = () => {
    const dispatch = useDispatch();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const [loginAccount, loginState] = useLoginAccountMutation();
    const { isSuccess, reset } = loginState;

    useEffect(() => {
        return () => {
            reset();
        };
    }, [reset]);

    useEffect(() => {
        if (isSuccess) {
            toast.success(t('Login successful'));
            // ARCHON: brand-new accounts go through the setup wizard first
            const needsOnboarding = loginState.data?.user?.onboarded === false;
            reset();
            dispatch(lobbyConnectRequested());
            dispatch(lobbyAuthenticateRequested());
            navigate(needsOnboarding ? '/welcome' : '/');
        }
    }, [dispatch, isSuccess, loginState.data, navigate, reset, t]);

    // ARCHON: complete an SSO redirect: tokens arrive in the URL fragment
    // (never sent to the server) as /login#sso=<base64url payload>
    useEffect(() => {
        const hash = location.hash?.startsWith('#') ? location.hash.slice(1) : '';
        if (!hash) {
            return;
        }

        const params = new URLSearchParams(hash);
        const ssoError = params.get('ssoError');
        const ssoPayload = params.get('sso');

        if (ssoError) {
            toast.error(ssoError);
            navigate('/login', { replace: true });

            return;
        }

        if (!ssoPayload) {
            return;
        }

        try {
            const decoded = JSON.parse(atob(ssoPayload.replace(/-/g, '+').replace(/_/g, '/')));

            dispatch(
                setAuthTokens({
                    token: decoded.token,
                    refreshToken: decoded.refreshToken,
                    user: decoded.user
                })
            );
            dispatch(lobbyConnectRequested());
            dispatch(lobbyAuthenticateRequested());
            toast.success(t('Login successful'));
            navigate(decoded.user?.onboarded === false ? '/welcome' : '/', { replace: true });
        } catch (err) {
            toast.error(t('Login failed, please try again'));
            navigate('/login', { replace: true });
        }
    }, [dispatch, location.hash, navigate, t]);

    const apiState = loginState.isUninitialized
        ? null
        : {
              loading: loginState.isLoading,
              success: isSuccess,
              message: isSuccess
                  ? t('Login successful')
                  : loginState.error?.status === 401
                  ? t('Invalid username/password')
                  : loginState.error?.data?.message
          };

    return (
        <div className='mx-auto w-full max-w-2xl'>
            <Panel title={t('Login')}>
                <ApiStatus state={apiState} onClose={() => loginState.reset()} />
                {/* ARCHON: SSO login entry point */}
                <SsoButton mode='login' />
                <Login onSubmit={(values) => loginAccount(values)} />
            </Panel>
        </div>
    );
};

export default LoginContainer;
