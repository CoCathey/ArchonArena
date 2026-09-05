import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { faEnvelope } from '@fortawesome/free-solid-svg-icons';

import Icon from '../Icon';
import Link from '../Navigation/Link';
import { useGetUnreadMessageCountQuery } from '../../redux/api';

// A count, not a page of rows - cheap enough to poll while the tab is open.
// The lobby socket also invalidates it the moment a message arrives, so the
// poll is only the fallback for a player connected to a different lobby.
const UNREAD_POLL_MS = 60000;

/**
 * ARCHON: the direct-message envelope, with how many are waiting.
 *
 * Three placements share one component: the top bar during a game (default),
 * its mobile menu (`mobile`), and the sidebar everywhere else (`sidebar`).
 *
 * @param {{ mobile?: boolean, sidebar?: boolean, onNavigate?: () => void }} props
 */
const MessageBadge = ({ mobile = false, sidebar = false, onNavigate }) => {
    const { t } = useTranslation();
    const location = useLocation();
    const { data } = useGetUnreadMessageCountQuery(undefined, { pollingInterval: UNREAD_POLL_MS });

    const unread = data?.unread || 0;
    const active = location.pathname.startsWith('/messages');

    const count = unread > 0 && (
        <span
            className='ml-0.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.65rem] font-bold leading-[1.15rem] text-black'
            aria-label={t('{{count}} unread', { count: unread })}
        >
            {unread > 99 ? '99+' : unread}
        </span>
    );

    if (sidebar) {
        return (
            <Link
                href='/messages'
                onClick={onNavigate}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition ${
                    active
                        ? 'bg-accent/20 text-amber-300'
                        : 'text-foreground hover:bg-surface-secondary/70 hover:text-amber-200'
                }`}
            >
                <Icon icon={faEnvelope} />
                <span>{t('Messages')}</span>
                <span className='ml-auto'>{count}</span>
            </Link>
        );
    }

    const className = mobile
        ? 'inline-flex h-9 w-full items-center justify-start rounded-md px-3 text-sm font-medium text-foreground transition hover:bg-surface-secondary/55'
        : 'inline-flex h-9 min-w-0 items-center rounded-md px-3 text-sm font-medium text-amber-600 transition hover:bg-surface-secondary/55 dark:text-amber-300 lg:h-12';

    return (
        <Link href='/messages' className={className} onClick={onNavigate}>
            <span className='relative inline-flex h-full items-center gap-1.5 leading-none'>
                <Icon icon={faEnvelope} />
                {mobile && <span>{t('Messages')}</span>}
                {count}
            </span>
        </Link>
    );
};

MessageBadge.displayName = 'MessageBadge';

export default MessageBadge;
