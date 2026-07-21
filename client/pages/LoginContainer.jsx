import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Button, toast } from '@heroui/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Login from '../Components/Login';
import Panel from '../Components/Site/Panel';
import ApiStatus from '../Components/Site/ApiStatus';
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
    // ARCHON: SSO (OIDC) login support
    const [ssoProvider, setSsoProvider] = useState(null);

    useEffect(() => {
        return () => {
            reset();
        };
    }, [reset]);

    useEffect(() => {
        if (isSuccess) {
            toast.success(t('Login successful'));
            reset();
            dispatch(lobbyConnectRequested());
            dispatch(lobbyAuthenticateRequested());
            navigate('/');
        }
    }, [dispatch, isSuccess, navigate, reset, t]);

    // ARCHON: show the SSO button only when the server has a provider configured
    useEffect(() => {
        let cancelled = false;

        fetch('/api/account/oidc/status')
            .then((response) => response.json())
            .then((status) => {
                if (!cancelled && status.enabled) {
                    setSsoProvider(status.providerName);
                }
            })
            .catch(() => {});

        return () => {
            cancelled = true;
        };
    }, []);

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
            navigate('/', { replace: true });
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
                {ssoProvider && (
                    <div className='mb-4'>
                        <Button
                            className='w-full'
                            variant='primary'
                            onPress={() => {
                                window.location.href = '/api/account/oidc/login';
                            }}
                        >
                            {t('Sign in with {{provider}}', { provider: ssoProvider })}
                        </Button>
                        <div className='mt-3 text-center text-sm text-muted'>
                            {t('or use your local account')}
                        </div>
                    </div>
                )}
                <Login onSubmit={(values) => loginAccount(values)} />
            </Panel>
        </div>
    );
};

export default LoginContainer;
