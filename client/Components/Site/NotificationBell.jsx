import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Dropdown, Label } from '@heroui/react';
import moment from 'moment';
import { faBell } from '@fortawesome/free-solid-svg-icons';

import Icon from '../Icon';
import {
    useGetNotificationsQuery,
    useGetUnreadNotificationCountQuery,
    useMarkNotificationsReadMutation
} from '../../redux/api';

// The badge is a count, not a page of rows - cheap enough to poll while the
// tab is open. Web push (N6/PWA) replaces this later.
const UNREAD_POLL_MS = 60000;

/**
 * ARCHON (N2): the notification bell.
 *
 * Two queries on purpose: the badge polls a bare count, and the list is only
 * fetched once the dropdown is actually opened. Polling the full list every
 * minute for every signed-in tab would be the expensive way to render a number.
 *
 * @param {{ mobile?: boolean }} props
 */
const NotificationBell = ({ mobile = false }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [isOpen, setIsOpen] = useState(false);

    const { data: unreadData } = useGetUnreadNotificationCountQuery(undefined, {
        pollingInterval: UNREAD_POLL_MS
    });
    const { data: listData } = useGetNotificationsQuery({ limit: 15 }, { skip: !isOpen });
    const [markRead] = useMarkNotificationsReadMutation();

    const unread = unreadData?.unread || 0;
    const notifications = listData?.notifications || [];

    const onOpenChange = (open) => {
        setIsOpen(open);
    };

    const onAction = async (key) => {
        const id = String(key);

        if (id === '__mark-all') {
            await markRead(undefined)
                .unwrap()
                .catch(() => null);

            return;
        }

        const notification = notifications.find((entry) => String(entry.id) === id);

        if (!notification) {
            return;
        }

        // Reading a notification is what marks it read - a separate "mark as
        // read" step for something you have just looked at is busywork.
        if (!notification.read) {
            markRead([notification.id])
                .unwrap()
                .catch(() => null);
        }

        if (notification.url) {
            navigate(notification.url);
        }
    };

    const triggerClass = mobile
        ? '!inline-flex !h-9 !w-full !items-center !justify-start !rounded-md !bg-transparent !px-3 !text-sm !font-medium !text-foreground transition hover:!bg-surface-secondary/55'
        : '!inline-flex !h-9 !min-w-0 !items-center !rounded-md !bg-transparent !px-3 !text-sm !font-medium !text-amber-600 dark:!text-amber-300 transition hover:!bg-surface-secondary/55 lg:!h-12';

    return (
        <Dropdown onOpenChange={onOpenChange}>
            <Dropdown.Trigger>
                <span className={triggerClass} aria-label={t('Notifications')}>
                    <span className='relative inline-flex h-full items-center gap-1.5 leading-none'>
                        <Icon icon={faBell} />
                        {mobile && <span>{t('Notifications')}</span>}
                        {unread > 0 && (
                            <span
                                className='ml-0.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.65rem] font-bold leading-[1.15rem] text-black'
                                aria-label={t('{{count}} unread', { count: unread })}
                            >
                                {unread > 99 ? '99+' : unread}
                            </span>
                        )}
                    </span>
                </span>
            </Dropdown.Trigger>
            <Dropdown.Popover className='max-h-[70vh] w-[22rem] max-w-[90vw] overflow-y-auto rounded-xl border border-border/70 bg-overlay/95 p-1 text-foreground'>
                <Dropdown.Menu aria-label={t('Notifications')} onAction={onAction}>
                    {notifications.length === 0 ? (
                        <Dropdown.Item
                            className='rounded-md px-3 py-2'
                            key='__empty'
                            id='__empty'
                            textValue={t('Nothing new')}
                            isDisabled
                        >
                            <Label>{t('Nothing new')}</Label>
                        </Dropdown.Item>
                    ) : (
                        notifications.map((notification) => (
                            <Dropdown.Item
                                className={`rounded-md px-3 py-2 data-[hovered]:bg-surface-secondary/55 data-[focused]:bg-surface-secondary/55 ${
                                    notification.read ? 'opacity-70' : ''
                                }`}
                                key={String(notification.id)}
                                id={String(notification.id)}
                                textValue={notification.title}
                            >
                                <Label>
                                    <span className='flex flex-col gap-0.5'>
                                        <span className='flex items-start gap-2 text-sm font-medium'>
                                            {!notification.read && (
                                                <span
                                                    className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400'
                                                    aria-hidden='true'
                                                />
                                            )}
                                            <span className='min-w-0'>{notification.title}</span>
                                        </span>
                                        {notification.body && (
                                            <span className='text-xs text-muted'>
                                                {notification.body}
                                            </span>
                                        )}
                                        <span className='text-[0.65rem] text-muted'>
                                            {moment(notification.createdAt).fromNow()}
                                        </span>
                                    </span>
                                </Label>
                            </Dropdown.Item>
                        ))
                    )}
                    {unread > 0 ? (
                        <Dropdown.Item
                            className='rounded-md px-3 py-2 data-[hovered]:bg-surface-secondary/55'
                            key='__mark-all'
                            id='__mark-all'
                            textValue={t('Mark all as read')}
                        >
                            <Label>{t('Mark all as read')}</Label>
                        </Dropdown.Item>
                    ) : null}
                </Dropdown.Menu>
            </Dropdown.Popover>
        </Dropdown>
    );
};

NotificationBell.displayName = 'NotificationBell';

export default NotificationBell;
