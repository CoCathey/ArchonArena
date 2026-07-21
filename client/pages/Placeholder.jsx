import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import BrandMark from '../assets/img/aa_mark.svg';

/**
 * ARCHON: stand-in page for roadmap features that have navigation entries
 * before their implementation phase lands (see ROADMAP.md).
 */
const Placeholder = ({ title, description }) => {
    const { t } = useTranslation();

    return (
        <div className='mx-auto w-full max-w-2xl'>
            <Panel title={t(title)}>
                <div className='flex flex-col items-center gap-4 py-10 text-center'>
                    <img src={BrandMark} alt='' className='h-16 w-16 opacity-60' />
                    <div className='text-lg font-semibold text-foreground'>{t('Coming soon')}</div>
                    <p className='max-w-md text-sm text-muted'>
                        {t(
                            description ||
                                'This part of Archon Arena is under construction. Check back soon!'
                        )}
                    </p>
                </div>
            </Panel>
        </div>
    );
};

Placeholder.displayName = 'Placeholder';

export default Placeholder;
