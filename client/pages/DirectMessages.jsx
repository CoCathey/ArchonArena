import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Button as HeroButton, Input, TextArea, toast } from '@heroui/react';
import moment from 'moment';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import Avatar from '../Components/Site/Avatar';
import PlayerName from '../Components/Site/PlayerName';
import Link from '../Components/Navigation/Link';
import { serverMessage } from '../redux/apiError';
import {
    useGetConversationsQuery,
    useGetMessageThreadQuery,
    useMarkThreadReadMutation,
    useSendDirectMessageMutation
} from '../redux/api';

// Fallbacks only: the lobby socket refetches the moment a message lands. The
// polls cover a player connected to a different lobby process.
const INBOX_POLL_MS = 30000;
const THREAD_POLL_MS = 15000;

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asDate = (value) => {
    if (!value) {
        return null;
    }

    const text = typeof value === 'string' ? value : String(value);
    const time = new Date(/[Zz]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);

    return Number.isNaN(time.getTime()) ? null : time;
};

/**
 * ARCHON: direct messages - the inbox on the left, one thread on the right.
 *
 * A tournament pairs two people who have to agree on when to play, and until
 * this the platform gave them a scheduler and no way to talk. The page is
 * deliberately plain: a list of people, a thread, a box. The scheduler stays
 * where it was, on the match; this is the conversation around it.
 */
const DirectMessages = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { username: withUsername } = useParams();
    const user = useSelector((state) => state.account.user);
    const onlineUsers = useSelector((state) => state.lobby.users);

    const [draft, setDraft] = useState('');
    const [recipient, setRecipient] = useState('');
    const listRef = useRef(null);

    const { data: inboxData } = useGetConversationsQuery(undefined, {
        skip: !user,
        pollingInterval: INBOX_POLL_MS
    });
    const { data: threadData, isFetching: threadLoading } = useGetMessageThreadQuery(
        { username: withUsername },
        { skip: !user || !withUsername, pollingInterval: THREAD_POLL_MS }
    );
    const [send, sendState] = useSendDirectMessageMutation();
    const [markRead] = useMarkThreadReadMutation();

    const conversations = inboxData?.conversations || [];
    const thread = threadData?.success ? threadData : null;
    const messages = thread?.messages || [];
    const unreadHere = messages.some((message) => !message.fromMe && !message.readAt);

    // Reading the thread is what marks it read. Keyed on the last message, so
    // a message arriving while the thread is open is marked too.
    const lastId = messages.length ? messages[messages.length - 1].id : null;

    useEffect(() => {
        if (withUsername && unreadHere && lastId) {
            markRead(withUsername)
                .unwrap()
                .catch(() => null);
        }
    }, [withUsername, unreadHere, lastId, markRead]);

    // Newest at the bottom, and keep it in view as more arrive.
    useEffect(() => {
        if (listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }
    }, [lastId, withUsername]);

    if (!user) {
        return (
            <AlertPanel
                type='warning'
                message={t('You need to be logged in to see your messages')}
            />
        );
    }

    const onlineNames = new Set((onlineUsers || []).map((entry) => entry.name));

    const submit = async () => {
        const text = draft.trim();

        if (!text || !withUsername) {
            return;
        }

        try {
            const result = await send({ username: withUsername, text }).unwrap();

            if (result.success) {
                setDraft('');
            } else {
                toast.danger(result.message || t('Could not send your message'));
            }
        } catch (err) {
            toast.danger(serverMessage(err, t('Could not send your message')));
        }
    };

    const openNew = (event) => {
        event.preventDefault();

        const name = recipient.trim();

        if (name) {
            setRecipient('');
            navigate(`/messages/${encodeURIComponent(name)}`);
        }
    };

    const when = (value) => {
        const date = asDate(value);

        return date ? moment(date).calendar() : '';
    };

    return (
        <div className='mx-auto w-full max-w-5xl'>
            <div className='grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]'>
                <Panel title={t('Messages')}>
                    <form className='mb-3 flex gap-2' onSubmit={openNew}>
                        <Input
                            className='flex-1'
                            placeholder={t('Message a player by username')}
                            value={recipient}
                            onChange={(event) => setRecipient(event.target.value)}
                        />
                        <HeroButton type='submit' size='sm' variant='tertiary'>
                            {t('Open')}
                        </HeroButton>
                    </form>

                    {conversations.length === 0 ? (
                        <div className='text-sm text-muted'>
                            {t(
                                'No conversations yet. Your match panel has a button to message your opponent.'
                            )}
                        </div>
                    ) : (
                        <div className='space-y-1'>
                            {conversations.map((conversation) => {
                                const active =
                                    withUsername &&
                                    conversation.username.toLowerCase() ===
                                        withUsername.toLowerCase();

                                return (
                                    <Link
                                        key={conversation.userId}
                                        href={`/messages/${encodeURIComponent(
                                            conversation.username
                                        )}`}
                                        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition ${
                                            active
                                                ? 'border-amber-400/50 bg-amber-400/10'
                                                : 'border-border/50 bg-surface-secondary/40 hover:border-amber-300/50'
                                        }`}
                                    >
                                        <Avatar imgPath={conversation.avatar} />
                                        <span className='min-w-0 flex-1'>
                                            <span className='flex items-center gap-1.5'>
                                                <span className='truncate font-semibold text-foreground'>
                                                    {conversation.username}
                                                </span>
                                                <span
                                                    className={`inline-block h-2 w-2 rounded-full ${
                                                        onlineNames.has(conversation.username)
                                                            ? 'bg-green-400'
                                                            : 'bg-border'
                                                    }`}
                                                    title={
                                                        onlineNames.has(conversation.username)
                                                            ? t('Online')
                                                            : t('Offline')
                                                    }
                                                />
                                                {conversation.unread > 0 && (
                                                    <span className='ml-auto inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.65rem] font-bold leading-[1.15rem] text-black'>
                                                        {conversation.unread}
                                                    </span>
                                                )}
                                            </span>
                                            <span className='block truncate text-xs text-muted'>
                                                {conversation.lastMessage.fromMe
                                                    ? `${t('You')}: `
                                                    : ''}
                                                {conversation.lastMessage.text}
                                            </span>
                                        </span>
                                    </Link>
                                );
                            })}
                        </div>
                    )}
                </Panel>

                <Panel
                    title={
                        withUsername
                            ? t('Conversation with {{name}}', {
                                  name: thread?.other?.username || withUsername
                              })
                            : t('Pick a conversation')
                    }
                >
                    {!withUsername ? (
                        <div className='text-sm text-muted'>
                            {t(
                                'Choose somebody on the left, or type a username above to start a new conversation.'
                            )}
                        </div>
                    ) : threadData && !threadData.success ? (
                        <AlertPanel
                            type='warning'
                            message={threadData.message || t('No such player')}
                        />
                    ) : (
                        <div className='flex h-[60vh] flex-col'>
                            <div
                                ref={listRef}
                                className='flex-1 space-y-2 overflow-y-auto rounded-md border border-border/50 bg-surface-secondary/30 p-3'
                            >
                                {thread?.hasMore && (
                                    <div className='text-center text-xs text-muted'>
                                        {t('Earlier messages are not shown.')}
                                    </div>
                                )}
                                {messages.length === 0 && !threadLoading && (
                                    <div className='text-sm text-muted'>
                                        {t(
                                            'No messages yet. Say hello, or suggest a time to play.'
                                        )}
                                    </div>
                                )}
                                {messages.map((message) => (
                                    <div
                                        key={message.id}
                                        className={`flex ${
                                            message.fromMe ? 'justify-end' : 'justify-start'
                                        }`}
                                    >
                                        <div
                                            className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${
                                                message.fromMe
                                                    ? 'bg-amber-400/15 text-foreground'
                                                    : 'bg-overlay/80 text-foreground'
                                            }`}
                                        >
                                            {!message.fromMe && thread?.other?.username && (
                                                <div className='mb-0.5 text-xs'>
                                                    <PlayerName
                                                        link
                                                        username={thread.other.username}
                                                    />
                                                </div>
                                            )}
                                            <div className='whitespace-pre-wrap break-words'>
                                                {message.text}
                                            </div>
                                            <div className='mt-0.5 text-right text-[0.65rem] text-muted'>
                                                {when(message.sentAt)}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {thread && !thread.canMessage ? (
                                <div className='mt-2 text-sm text-muted'>
                                    {t('You cannot message this player.')}
                                </div>
                            ) : (
                                <form
                                    className='mt-2 flex items-end gap-2'
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        submit();
                                    }}
                                >
                                    <TextArea
                                        className='flex-1'
                                        rows={2}
                                        maxLength={2000}
                                        placeholder={t(
                                            'Write a message - Enter sends, Shift+Enter for a new line'
                                        )}
                                        value={draft}
                                        onChange={(event) => setDraft(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' && !event.shiftKey) {
                                                event.preventDefault();
                                                submit();
                                            }
                                        }}
                                    />
                                    <HeroButton
                                        type='submit'
                                        variant='primary'
                                        isPending={sendState.isLoading}
                                        isDisabled={!draft.trim()}
                                    >
                                        {t('Send')}
                                    </HeroButton>
                                </form>
                            )}
                        </div>
                    )}
                </Panel>
            </div>
        </div>
    );
};

DirectMessages.displayName = 'DirectMessages';

export default DirectMessages;
