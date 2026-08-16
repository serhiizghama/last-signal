import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnreadReportsCount } from '../reports/useReportsQuery';

/**
 * Matches the mockup's screen structure (Map / Base / Units / Market / Reports / Side /
 * Settings).
 */
const NAV_ITEMS = ['map', 'base', 'units', 'market', 'reports', 'side', 'settings'] as const;

export type NavTab = (typeof NAV_ITEMS)[number];

/**
 * Screens that actually exist and can be switched to. Map and Base joined in M2c.1, Reports in
 * M2c.3 — the rest stay visibly present but disabled rather than faked, so the player can see
 * what's coming without being able to open a screen that isn't built yet.
 */
const ENABLED_TABS: readonly NavTab[] = ['map', 'base', 'reports'];

interface BottomNavProps {
  active: NavTab;
  onNavigate: (tab: NavTab) => void;
}

export function BottomNav({ active, onNavigate }: BottomNavProps): ReactElement {
  const { t } = useTranslation();
  // Self-contained rather than threaded through every screen's props: `BottomNav` is mounted
  // by every screen (Map/Base/Reports today), so owning this query itself is what lets the
  // `Отчёты` badge track the account's unread count regardless of which tab is active, without
  // touching those screens at all.
  const unreadQuery = useUnreadReportsCount();
  const unreadCount = unreadQuery.data ?? 0;

  return (
    <nav className="bottom-nav" aria-label={t('nav.ariaLabel')}>
      {NAV_ITEMS.map((item) => {
        const enabled = ENABLED_TABS.includes(item);
        const isActive = item === active;
        const modifier = isActive
          ? ' bottom-nav__item--active'
          : enabled
            ? ' bottom-nav__item--enabled'
            : '';
        return (
          <button
            key={item}
            type="button"
            className={`bottom-nav__item${modifier}`}
            disabled={!enabled}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onNavigate(item)}
          >
            {t(`nav.${item}`)}
            {item === 'reports' && unreadCount > 0 && (
              <>
                {' '}
                <span className="bottom-nav__badge">{unreadCount}</span>
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
