import React from 'react';
import PropTypes from 'prop-types';
import classNames from 'classnames';

// ARCHON: the generic KeyForge archon-card back, not TCO's branded one.
import IdentityDefault from '../../assets/img/idbacks/idback_blanks/cardback_1.png';

function CardSizeOption(props) {
    let { name, label, selected, onSelect } = props;

    const handleClick = () => {
        if (onSelect) {
            onSelect(name);
        }
    };

    return (
        <div key={name} className='mx-1.5 inline-block' onClick={handleClick}>
            <div className={classNames('game-card', 'vertical', name, { selected: selected })}>
                <img className={classNames('game-card', 'vertical', name)} src={IdentityDefault} />
            </div>
            <span className='inline-block w-full text-center'>{label}</span>
        </div>
    );
}

CardSizeOption.propTypes = {
    label: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    onSelect: PropTypes.func,
    selected: PropTypes.bool
};

export default CardSizeOption;
