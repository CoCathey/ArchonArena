import React from 'react';
import { Avatar as HeroAvatar } from '@heroui/react';

import { accentStyle, frameClass } from '../../cosmetics';

/**
 * @typedef AvatarProps
 * @property {boolean} [float] Whether or not to float the image
 * @property {string} imgPath The username whose avatar to display
 * @property {object} [cosmetics] ARCHON (N12): the owner's resolved cosmetics,
 *           for the avatar frame. Already filtered server-side against what
 *           that account may use, so anything here is theirs to show.
 */

/**
 *
 * @param {AvatarProps} props
 */
const Avatar = ({ float, imgPath, cosmetics }) => {
    const imageSrc = imgPath ? `/img/avatar/${imgPath}.png` : undefined;
    const frame = frameClass(cosmetics);
    // Whatever wraps the image carries the spacing, so a framed and an
    // unframed avatar take up the same room in a list.
    const outerClass = `shrink-0 align-middle mr-1.5${float ? ' float-left' : ''}`;

    const avatar = (
        <HeroAvatar
            className={`gravatar size-8 shrink-0${frame ? '' : ` ${outerClass}`}`}
            size='sm'
        >
            {imageSrc && <HeroAvatar.Image alt='' src={imageSrc} />}
            <HeroAvatar.Fallback>?</HeroAvatar.Fallback>
        </HeroAvatar>
    );

    // No frame is the common case by a long way, so it costs no extra element.
    if (!frame) {
        return avatar;
    }

    return (
        <span className={`${frame} ${outerClass}`} style={accentStyle(cosmetics)}>
            {avatar}
        </span>
    );
};

export default Avatar;
