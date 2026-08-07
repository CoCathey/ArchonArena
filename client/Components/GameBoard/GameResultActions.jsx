import React from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';

import {
    gameCloseRequested,
    gameSendMessage,
    lobbyLeaveGameRequested
} from '../../redux/socketActions';
import Link from '../Navigation/Link';

/**
 * ARCHON: the actions a finished game leaves you with beyond a rematch - the
 * engine's own GameWonPrompt already offers "Continue Playing" and the
 * rematch modes, so this only covers what it does not: leaving to watch the
 * replay, or leaving back to the lobby. Mirrors GameContextMenu's leave path
 * (both sockets, then close) rather than adding a second way to disconnect.
 *
 * @param {{ gameId: string }} props
 */
const GameResultActions = ({ gameId }) => {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const { t } = useTranslation();

    const onBackToLobby = () => {
        dispatch(gameSendMessage('leavegame'));
        dispatch(lobbyLeaveGameRequested(gameId));
        dispatch(gameCloseRequested());
        navigate('/');
    };

    return (
        <div className='mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1'>
            <Link href={`/replay/${gameId}`} className='text-xs text-amber-300 underline'>
                {t('View Replay')}
            </Link>
            <Button
                variant='light'
                size='sm'
                className='h-6 min-h-0 px-2 text-xs text-muted hover:text-foreground'
                onPress={onBackToLobby}
            >
                {t('Back to Lobby')}
            </Button>
        </div>
    );
};

GameResultActions.displayName = 'GameResultActions';

export default GameResultActions;
