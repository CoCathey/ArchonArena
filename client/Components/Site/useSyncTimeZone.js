import { useEffect } from 'react';

import { useSetTimeZoneMutation } from '../../redux/api';

/** The zone this browser is in, as Intl reports it; undefined when it cannot. */
export const browserTimeZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
};

/**
 * ARCHON: tell the account which time zone this browser is in.
 *
 * Emailed match times used to say "19:00 UTC" to everybody, because the server
 * had no idea where anybody was. The browser has always known; this hands the
 * answer over once per sign-in, and again whenever it changes - a player who
 * travels, or reads the site from a different machine, is covered without
 * finding a setting. A setting nobody has to find is a setting that is set.
 *
 * Only when the two disagree, so an ordinary page load costs no request.
 *
 * @param {object|undefined} user the signed-in account, or nothing
 */
const useSyncTimeZone = (user) => {
    const [setTimeZone] = useSetTimeZoneMutation();
    const detected = browserTimeZone();
    const remembered = user?.settings?.timeZone;

    useEffect(() => {
        if (!user || !detected || detected === remembered) {
            return;
        }

        setTimeZone(detected)
            .unwrap()
            .catch(() => {
                // Nothing to do: the email says UTC, exactly as it did before.
            });
    }, [user, detected, remembered, setTimeZone]);
};

export default useSyncTimeZone;
