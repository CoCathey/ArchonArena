import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { Button as HeroButton, Input, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import { useAdminResetPasswordMutation, useAdminDeleteUserMutation } from '../../redux/api';

/**
 * ARCHON: admin account tools - set a new password for a locked-out user,
 * and delete (anonymize) an account. Delete is a soft delete: the account
 * row survives so rating/game history stays intact, but the username is
 * freed and all PII/credentials are wiped.
 *
 * @param {{ username: string, onDeleted?: () => void }} props
 */
const AdminUserDanger = ({ username, onDeleted }) => {
    const { t } = useTranslation();
    const currentUser = useSelector((state) => state.account.user);
    const [newPassword, setNewPassword] = useState('');
    const [resetPassword, resetState] = useAdminResetPasswordMutation();
    const [deleteUser, deleteState] = useAdminDeleteUserMutation();

    const isSelf = currentUser?.username?.toLowerCase() === username?.toLowerCase();

    const onReset = async () => {
        try {
            const result = await resetPassword({ username, newPassword }).unwrap();

            if (result.success) {
                toast.success(
                    t('Password set. Give it to the player - their sessions were ended.')
                );
                setNewPassword('');
            } else {
                toast.danger(result.message || t('Could not reset password'));
            }
        } catch {
            toast.danger(t('Could not reset password'));
        }
    };

    const onDelete = async () => {
        if (
            !window.confirm(
                t(
                    'Delete {{username}}? Their username is freed and account wiped. Game and rating history are preserved. This cannot be undone.',
                    { username }
                )
            )
        ) {
            return;
        }

        try {
            const result = await deleteUser(username).unwrap();

            if (result.success) {
                toast.success(t('{{username}} was deleted', { username }));
                onDeleted?.();
            } else {
                toast.danger(result.message || t('Could not delete user'));
            }
        } catch {
            toast.danger(t('Could not delete user'));
        }
    };

    return (
        <Panel title={t('Account tools')}>
            <div className='space-y-4'>
                <div>
                    <div className='mb-1 text-sm font-semibold text-foreground'>
                        {t('Reset password')}
                    </div>
                    <div className='flex flex-wrap items-center gap-2'>
                        <Input
                            className='min-w-56 flex-1'
                            type='text'
                            placeholder={t('New password (min 6 characters)')}
                            value={newPassword}
                            onChange={(event) => setNewPassword(event.target.value)}
                        />
                        <HeroButton
                            size='sm'
                            variant='primary'
                            isDisabled={newPassword.length < 6}
                            isPending={resetState.isLoading}
                            onPress={onReset}
                        >
                            {t('Set password')}
                        </HeroButton>
                    </div>
                    <p className='mt-1 text-xs text-muted'>
                        {t(
                            "Sets a temporary password and ends the player's active sessions. Share it with them privately."
                        )}
                    </p>
                </div>

                <div className='border-t border-red-500/30 pt-3'>
                    <div className='mb-1 text-sm font-semibold text-red-400'>
                        {t('Delete account')}
                    </div>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className='max-w-md text-xs text-muted'>
                            {t(
                                'Frees the username and wipes personal data. Game and rating history stay intact for other players. Cannot be undone.'
                            )}
                        </p>
                        <HeroButton
                            size='sm'
                            variant='danger'
                            isDisabled={isSelf}
                            isPending={deleteState.isLoading}
                            onPress={onDelete}
                        >
                            {isSelf ? t('Cannot delete yourself') : t('Delete user')}
                        </HeroButton>
                    </div>
                </div>
            </div>
        </Panel>
    );
};

AdminUserDanger.displayName = 'AdminUserDanger';

export default AdminUserDanger;
