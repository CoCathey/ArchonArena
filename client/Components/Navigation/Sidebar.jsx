import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Button as HeroButton } from '@heroui/react';

import { SidebarMenu, ProfileMenu } from '../../menus';
import Avatar from '../Site/Avatar';
import BugReportModal from '../Site/BugReportModal';
import LanguageSelector from './LanguageSelector';
import Link from './Link';

import BrandMark from '../../assets/img/aa_mark.svg';

/**
 * ARCHON: chess.com-style fixed left sidebar. Sections open flyout
 * submenus; Sign Up / Log In (or the profile menu) live at the bottom.
 * On small screens it collapses to a top bar with a slide-over menu.
 *
 * @param {{ appName: string, user: any }} props
 */
const Sidebar = ({ appName, user }) => {
    const { t } = useTranslation();
    const location = useLocation();
    const [openSection, setOpenSection] = useState(null);
    const [mobileOpen, setMobileOpen] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const [bugReportOpen, setBugReportOpen] = useState(false);

    // Keep the flyout open through a small pointer slip: closing is
    // delayed, and any re-entry (into the button, the bridge gap, or the
    // flyout itself) cancels the pending close.
    const closeTimeout = useRef(null);

    const cancelScheduledClose = () => {
        if (closeTimeout.current) {
            clearTimeout(closeTimeout.current);
            closeTimeout.current = null;
        }
    };

    const openSectionNow = (title) => {
        cancelScheduledClose();
        setOpenSection(title);
    };

    const scheduleClose = () => {
        cancelScheduledClose();
        closeTimeout.current = setTimeout(() => {
            setOpenSection(null);
            closeTimeout.current = null;
        }, 400);
    };

    useEffect(() => cancelScheduledClose, []);

    const canSee = (item) => {
        if (item.showOnlyWhenLoggedIn && !user) {
            return false;
        }

        if (item.showOnlyWhenLoggedOut && user) {
            return false;
        }

        if (item.permission && !user?.permissions?.[item.permission]) {
            return false;
        }

        return true;
    };

    const visibleSections = SidebarMenu.filter(canSee)
        .map((section) => ({
            ...section,
            childItems: section.childItems?.filter(canSee)
        }))
        .filter((section) => section.path || section.childItems?.length > 0);

    const isSectionActive = (section) => {
        if (section.path) {
            return location.pathname === section.path;
        }

        return section.childItems?.some((item) => location.pathname === item.path);
    };

    const closeAll = () => {
        cancelScheduledClose();
        setOpenSection(null);
        setMobileOpen(false);
        setProfileOpen(false);
    };

    const sectionButtonClass = (active) =>
        `flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-semibold transition ` +
        (active
            ? 'bg-accent/20 text-amber-300'
            : 'text-foreground hover:bg-surface-secondary/70 hover:text-amber-200');

    const childLinkClass = (active) =>
        `block rounded px-3 py-2 text-sm transition ` +
        (active
            ? 'bg-accent/20 text-amber-300'
            : 'text-foreground/90 hover:bg-surface-secondary/70 hover:text-amber-200');

    const renderSection = (section) => {
        const active = isSectionActive(section);

        if (section.path) {
            return (
                <Link
                    key={section.title}
                    href={section.path}
                    className={sectionButtonClass(active)}
                    onClick={closeAll}
                >
                    {t(section.title)}
                </Link>
            );
        }

        const isOpen = openSection === section.title;
        const toggle = () => setOpenSection(isOpen ? null : section.title);

        return (
            <div
                key={section.title}
                className='relative'
                onMouseEnter={() => openSectionNow(section.title)}
                onMouseLeave={scheduleClose}
            >
                {/* Header: the label navigates to the section's landing page
                    (like Learn/Watch), while the caret opens the flyout. On
                    desktop hover also opens it; the caret is the tap target
                    for touch. Sections without a landing page toggle wholesale. */}
                <div className={`${sectionButtonClass(active || isOpen)} gap-1`}>
                    {section.landingPath ? (
                        <Link
                            href={section.landingPath}
                            className='min-w-0 flex-1 truncate'
                            onClick={closeAll}
                        >
                            {t(section.title)}
                        </Link>
                    ) : (
                        <button
                            type='button'
                            className='min-w-0 flex-1 truncate text-left'
                            onClick={toggle}
                        >
                            {t(section.title)}
                        </button>
                    )}
                    <button
                        type='button'
                        aria-label={t('Toggle {{title}} menu', { title: t(section.title) })}
                        aria-expanded={isOpen}
                        className='-mr-1 shrink-0 px-1.5 py-0.5 text-xs text-muted'
                        onClick={toggle}
                    >
                        ›
                    </button>
                </div>
                {isOpen && (
                    // Outer wrapper includes the gap and a little vertical
                    // slack so hover survives the pointer crossing from the
                    // button into the flyout, or a few pixels of slip.
                    <div className='top-0 z-50 lg:absolute lg:left-full lg:w-60 lg:pl-3 lg:pb-2'>
                        <div className='rounded-md border border-border/70 bg-overlay p-1.5 shadow-xl'>
                            {section.childItems.map((item) => (
                                <Link
                                    key={item.path}
                                    href={item.path}
                                    className={childLinkClass(location.pathname === item.path)}
                                    onClick={closeAll}
                                >
                                    {t(item.title)}
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const authControls = user ? (
        <div className='relative'>
            {profileOpen && (
                <div className='absolute bottom-full left-0 right-0 z-50 mb-1 rounded-md border border-border/70 bg-overlay/98 p-1.5 shadow-xl'>
                    {ProfileMenu.map((item) => (
                        <Link
                            key={item.path}
                            href={item.path}
                            className={childLinkClass(false)}
                            onClick={closeAll}
                        >
                            {t(item.title)}
                        </Link>
                    ))}
                </div>
            )}
            <button
                type='button'
                className='flex w-full items-center gap-1 rounded-md px-2 py-2 text-left text-sm font-semibold text-foreground transition hover:bg-surface-secondary/70'
                onClick={() => setProfileOpen((open) => !open)}
            >
                <Avatar imgPath={user.avatar} />
                <span className='truncate'>{user.username}</span>
            </button>
        </div>
    ) : (
        <div className='space-y-2'>
            <Link href='/register' onClick={closeAll}>
                <HeroButton variant='primary' className='w-full'>
                    {t('Sign Up')}
                </HeroButton>
            </Link>
            <Link href='/login' onClick={closeAll}>
                <HeroButton variant='tertiary' className='w-full'>
                    {t('Log In')}
                </HeroButton>
            </Link>
        </div>
    );

    const menuBody = (
        <>
            {/* overflow must stay visible on desktop or the flyouts get
                clipped inside the column (and force horizontal scrolling);
                mobile renders submenus inline so it can scroll freely */}
            <nav className='flex-1 space-y-1 overflow-y-auto px-2 py-3 lg:overflow-visible'>
                {visibleSections.map(renderSection)}
            </nav>
            <div className='space-y-2 border-t border-border/70 px-3 py-3'>
                {/* ARCHON: beta feedback entry point - always visible */}
                <button
                    type='button'
                    onClick={() => {
                        closeAll();
                        setBugReportOpen(true);
                    }}
                    className='flex w-full items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-left text-xs text-amber-200 transition hover:bg-amber-400/20'
                >
                    <span className='rounded bg-amber-400/25 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300'>
                        {t('Beta')}
                    </span>
                    {t('Report a bug')}
                </button>
                {authControls}
                <div className='flex items-center justify-between'>
                    <Link
                        href='/about'
                        className='text-xs text-muted transition hover:text-amber-200'
                        onClick={closeAll}
                    >
                        {t('Help & Support')}
                    </Link>
                    <LanguageSelector />
                </div>
            </div>
        </>
    );

    return (
        <>
            {bugReportOpen && (
                <BugReportModal user={user} onClose={() => setBugReportOpen(false)} />
            )}
            {/* Desktop sidebar */}
            <aside className='fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-border/80 bg-overlay/95 lg:flex'>
                <Link href='/' className='flex items-center gap-2 px-4 py-4' onClick={closeAll}>
                    <img src={BrandMark} className='h-8 w-8' alt='' />
                    <span className='text-base font-bold uppercase tracking-[0.14em] text-foreground'>
                        {appName}
                    </span>
                </Link>
                {menuBody}
            </aside>

            {/* Mobile top bar + slide-over */}
            <div className='fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-between border-b border-border/80 bg-overlay/95 px-3 lg:hidden'>
                <Link href='/' className='flex items-center gap-2' onClick={closeAll}>
                    <img src={BrandMark} className='h-7 w-7' alt='' />
                    <span className='text-sm font-bold uppercase tracking-[0.14em] text-foreground'>
                        {appName}
                    </span>
                </Link>
                <HeroButton
                    size='sm'
                    variant='tertiary'
                    className='!h-8 !min-w-10 !px-2'
                    onPress={() => setMobileOpen((open) => !open)}
                >
                    {mobileOpen ? t('Close') : t('Menu')}
                </HeroButton>
            </div>
            {mobileOpen && (
                <div className='fixed inset-0 top-12 z-40 flex flex-col overflow-y-auto bg-overlay/98 lg:hidden'>
                    {menuBody}
                </div>
            )}
        </>
    );
};

Sidebar.displayName = 'Sidebar';

export default Sidebar;
