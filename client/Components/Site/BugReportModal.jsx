import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Button as HeroButton, Modal as HeroModal, toast } from '@heroui/react';

import Link from '../Navigation/Link';
import { useSubmitBugReportMutation } from '../../redux/api';

/**
 * ARCHON: beta feedback. The sidebar's "Report a Bug" opens this;
 * the current page is captured automatically so reports carry context.
 */
const BugReportModal = ({ user, onClose }) => {
    const { t } = useTranslation();
    const location = useLocation();
    const [body, setBody] = useState('');
    const [submitReport, submitState] = useSubmitBugReportMutation();

    const onSubmit = async () => {
        try {
            const result = await submitReport({
                body,
                page: location.pathname
            }).unwrap();

            if (result.success) {
                toast.success(t('Thank you! Your report has been filed.'));
                onClose();
            } else {
                toast.danger(result.message || t('Could not send the report'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not send the report'));
        }
    };

    return (
        <HeroModal.Backdrop isOpen onOpenChange={onClose}>
            <HeroModal.Container placement='center'>
                <HeroModal.Dialog className='sm:max-w-lg'>
                    <HeroModal.CloseTrigger />
                    <HeroModal.Header>
                        <HeroModal.Heading>{t('Report a Bug')}</HeroModal.Heading>
                    </HeroModal.Header>
                    <HeroModal.Body>
                        {user ? (
                            <div className='space-y-3'>
                                <p className='text-sm text-muted'>
                                    {t(
                                        'Archon Arena is in beta - reports like this are how it gets better. What happened, and what did you expect instead?'
                                    )}
                                </p>
                                <textarea
                                    className='min-h-36 w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none'
                                    value={body}
                                    maxLength={5000}
                                    autoFocus
                                    placeholder={t(
                                        'e.g. I clicked Pair Next Round on my tournament and nothing happened…'
                                    )}
                                    onChange={(event) => setBody(event.target.value)}
                                />
                                <div className='flex items-center justify-between'>
                                    <span className='text-xs text-muted'>
                                        {t('Filed from {{page}}', {
                                            page: location.pathname
                                        })}
                                    </span>
                                    <HeroButton
                                        variant='primary'
                                        size='sm'
                                        isPending={submitState.isLoading}
                                        isDisabled={body.trim().length < 10}
                                        onPress={onSubmit}
                                    >
                                        {t('Send Report')}
                                    </HeroButton>
                                </div>
                            </div>
                        ) : (
                            <div className='space-y-3 py-2 text-center'>
                                <p className='text-sm text-muted'>
                                    {t('Log in to file a bug report - thank you for helping!')}
                                </p>
                                <Link href='/login' onClick={onClose}>
                                    <HeroButton variant='primary' size='sm'>
                                        {t('Log In')}
                                    </HeroButton>
                                </Link>
                            </div>
                        )}
                    </HeroModal.Body>
                </HeroModal.Dialog>
            </HeroModal.Container>
        </HeroModal.Backdrop>
    );
};

BugReportModal.displayName = 'BugReportModal';

export default BugReportModal;
