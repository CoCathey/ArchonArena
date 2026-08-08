import { faArrowRight } from '@fortawesome/free-solid-svg-icons';
import PropTypes from 'prop-types';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import CardImage from './CardImage';

const AbilityTargeting = (props) => {
    const { t, i18n } = useTranslation();
    const onMouseOver = useCallback(
        (card) => {
            if (card && props.onMouseOver) {
                props.onMouseOver(card);
            }
        },
        [props]
    );

    const onMouseOut = useCallback(
        (card) => {
            if (card && props.onMouseOut) {
                props.onMouseOut(card);
            }
        },
        [props]
    );

    const renderSimpleCard = (card, style) => (
        <div
            className='ability-targeting-card'
            style={style}
            onMouseOut={() => onMouseOut(card)}
            onMouseOver={() =>
                onMouseOver({
                    image: <CardImage card={{ ...card, facedown: false }} />,
                    size: 'normal'
                })
            }
        >
            <CardImage card={{ ...card, facedown: false }} />
        </div>
    );

    const count = props.targets.length;
    // Overlap margin: spread cards across available width, overlapping when
    // they don't fit. 100% = parent width, 4rem = card width (w-16).
    const overlapMargin =
        count > 1 ? { marginLeft: `calc((100% - ${count} * 4rem) / ${count - 1})` } : undefined;

    // N15: the engine already knows this prompt's source card (props.source);
    // name it explicitly rather than relying on the prompt text happening to
    // interpolate {{card}} into a sentence. Mirrors the mobile client's
    // "because of <card>" row (mobile/src/game/PromptPanel.tsx EffectContext).
    const localizedSourceName =
        i18n.language !== 'en' && props.source?.locale?.[i18n.language]?.name
            ? props.source.locale[i18n.language].name
            : props.source?.name || props.source?.label;

    return (
        <div className='ability-targeting'>
            <div className='ability-targeting-source'>
                {renderSimpleCard(props.source)}
                {localizedSourceName && (
                    <span className='ability-targeting-attribution'>
                        <span className='text-muted'>{t('because of')} </span>
                        {localizedSourceName}
                    </span>
                )}
                {count > 0 && <Icon icon={faArrowRight} />}
            </div>
            {count > 0 && (
                <div className={`ability-targeting-targets${count > 1 ? ' flex-1' : ''}`}>
                    {props.targets.map((target, index) => (
                        <React.Fragment key={target.uuid || index}>
                            {renderSimpleCard(target, index > 0 ? overlapMargin : undefined)}
                        </React.Fragment>
                    ))}
                </div>
            )}
        </div>
    );
};

AbilityTargeting.displayName = 'AbilityTargeting';
AbilityTargeting.propTypes = {
    onMouseOut: PropTypes.func,
    onMouseOver: PropTypes.func,
    source: PropTypes.object,
    targets: PropTypes.array
};

export default AbilityTargeting;
