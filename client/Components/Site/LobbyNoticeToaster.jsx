import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';

import { lobbyActions } from '../../redux/slices/lobbySlice';

/**
 * ARCHON: toasts the lobby's 'lobbynotice' messages.
 *
 * The lobby had one way to speak to a specific player - 'gameerror' - and it
 * only renders inside a pending table. The players this exists for have just
 * been cleared out of a finished tournament game and are looking at the game
 * list, which is exactly where nothing said "that decided your match" or "your
 * next table is waiting on the event page". Mounted once at the root, so the
 * sentence lands whatever page they are on.
 *
 * A notice with a url is followed when clicked, which is how "see the event
 * page" becomes one press rather than a search.
 */
const LobbyNoticeToaster = () => {
    const notice = useSelector((state) => state.lobby.notice);
    const dispatch = useDispatch();
    const navigate = useNavigate();

    useEffect(() => {
        if (!notice || !notice.message) {
            return;
        }

        // Long enough to read an instruction and act on it; the default is
        // sized for "saved".
        const options = {
            timeout: 12000,
            ...(notice.url
                ? {
                      actionProps: {
                          children: 'Open',
                          onPress: () => navigate(notice.url)
                      }
                  }
                : {})
        };

        if (notice.tone === 'success') {
            toast.success(notice.message, options);
        } else if (notice.tone === 'danger') {
            toast.danger(notice.message, options);
        } else if (notice.tone === 'warning') {
            toast.warning(notice.message, options);
        } else {
            toast.info(notice.message, options);
        }

        dispatch(lobbyActions.clearNotice());
    }, [dispatch, navigate, notice]);

    return null;
};

LobbyNoticeToaster.displayName = 'LobbyNoticeToaster';

export default LobbyNoticeToaster;
