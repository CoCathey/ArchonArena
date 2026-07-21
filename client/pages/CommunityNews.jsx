import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import NewsComponent from '../Components/News/News';
import Panel from '../Components/Site/Panel';
import { useGetNewsQuery } from '../redux/api';

/**
 * ARCHON: site news moved off the home page into Community > News.
 */
const CommunityNews = () => {
    const { t } = useTranslation();
    const { data: newsResponse, isLoading } = useGetNewsQuery({ limit: 20 });
    const news = newsResponse?.news || [];

    return (
        <div className='mx-auto w-full max-w-3xl'>
            <Panel title={t('Site News')}>
                {isLoading ? (
                    <div className='text-sm text-muted'>
                        <Trans>News loading, please wait...</Trans>
                    </div>
                ) : news.length === 0 ? (
                    <div className='text-sm text-muted'>{t('No announcements')}</div>
                ) : (
                    <NewsComponent news={news} />
                )}
            </Panel>
        </div>
    );
};

CommunityNews.displayName = 'CommunityNews';

export default CommunityNews;
