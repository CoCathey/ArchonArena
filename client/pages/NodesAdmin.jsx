import React, { useCallback, useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Button } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import ReactTable from '../Components/Table/ReactTable';
import { lobbySendMessage } from '../redux/socketActions';

const NodeAdmin = () => {
    const dispatch = useDispatch();
    const nodeStatus = useSelector((state) => state.admin.nodeStatus);

    useEffect(() => {
        dispatch(lobbySendMessage('getnodestatus'));
    }, [dispatch]);

    const onToggleNodeClick = useCallback(
        (node, event) => {
            event.preventDefault();
            dispatch(lobbySendMessage('togglenode', node.name));
        },
        [dispatch]
    );

    const onRefreshClick = useCallback(
        (event) => {
            event.preventDefault();
            dispatch(lobbySendMessage('getnodestatus'));
        },
        [dispatch]
    );

    const onRestartNodeClick = useCallback(
        (node, event) => {
            event.preventDefault();
            dispatch(lobbySendMessage('restartnode', node.name));
        },
        [dispatch]
    );

    const columns = useMemo(
        () => [
            { accessorKey: 'name', header: 'Node Name' },
            {
                accessorKey: 'numGames',
                header: 'Num Games',
                cell: ({ row }) =>
                    row.original.maxGames
                        ? `${row.original.numGames} / ${row.original.maxGames}`
                        : row.original.numGames
            },
            { accessorKey: 'status', header: 'Status' },
            { accessorKey: 'version', header: 'Version' },
            {
                id: 'actions',
                header: 'Actions',
                cell: ({ row }) => (
                    <div className='flex gap-2'>
                        <Button
                            type='button'
                            size='sm'
                            variant='tertiary'
                            onClick={(event) => onToggleNodeClick(row.original, event)}
                        >
                            {/* Labelled from the flag this button flips, not
                                from the status: a draining or disconnected node
                                is not disabled, and "Enable" described neither
                                its state nor what the click would do. */}
                            {row.original.disabled ? 'Enable' : 'Disable'}
                        </Button>
                        <Button
                            type='button'
                            size='sm'
                            variant='tertiary'
                            isDisabled={
                                row.original.draining || row.original.status === 'disconnected'
                            }
                            title='Stops taking new games, waits for the games in progress to finish, then restarts'
                            onClick={(event) => onRestartNodeClick(row.original, event)}
                        >
                            Restart
                        </Button>
                    </div>
                )
            }
        ],
        [onRestartNodeClick, onToggleNodeClick]
    );

    let content;

    if (!nodeStatus) {
        content = <div>Waiting for game node status from the lobby...</div>;
    } else if (nodeStatus.length > 0) {
        content = <ReactTable columns={columns} data={nodeStatus} disableSelection />;
    } else {
        content = <div>There are no game nodes connected. This is probably bad.</div>;
    }

    return (
        <div className='mx-auto w-full max-w-6xl'>
            <Panel title='Game Node Administration'>
                {content}

                <Button className='mt-2' size='sm' variant='primary' onClick={onRefreshClick}>
                    Refresh
                </Button>
            </Panel>
        </div>
    );
};

NodeAdmin.displayName = 'NodeAdmin';

export default NodeAdmin;
