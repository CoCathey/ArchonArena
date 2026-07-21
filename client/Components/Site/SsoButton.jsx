import React, { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';

/**
 * ARCHON: entry point for SSO (Keybringer) on the login and register pages.
 * Renders nothing unless the server reports an enabled OIDC provider, so
 * the pages look unchanged on installs without SSO configured.
 */
const SsoButton = ({ mode = 'login' }) => {
    const { t } = useTranslation();
    const [provider, setProvider] = useState(null);

    useEffect(() => {
        let cancelled = false;

        fetch('/api/account/oidc/status')
            .then((response) => response.json())
            .then((status) => {
                if (!cancelled && status.enabled) {
                    setProvider(status.providerName);
                }
            })
            .catch(() => {});

        return () => {
            cancelled = true;
        };
    }, []);

    if (!provider) {
        return null;
    }

    return (
        <div className='mb-4'>
            <Button
                className='w-full'
                variant='primary'
                onPress={() => {
                    window.location.href = '/api/account/oidc/login';
                }}
            >
                {mode === 'register'
                    ? t('Sign up with {{provider}}', { provider })
                    : t('Sign in with {{provider}}', { provider })}
            </Button>
            <div className='mt-3 text-center text-sm text-muted'>
                {mode === 'register'
                    ? t('or create a local account')
                    : t('or use your local account')}
            </div>
        </div>
    );
};

SsoButton.displayName = 'SsoButton';

export default SsoButton;
