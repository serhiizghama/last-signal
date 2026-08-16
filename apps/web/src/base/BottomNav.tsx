import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Matches the mockup's screen structure (Map / Base / Units / Market / Reports / Side /
 * Settings). Only Base exists yet in M1 — the rest are visibly present but disabled rather
 * than faked, so the player can see what's coming without being able to open a screen that
 * isn't built.
 */
const NAV_ITEMS = ['map', 'base', 'units', 'market', 'reports', 'side', 'settings'] as const;

export function BottomNav(): ReactElement {
  const { t } = useTranslation();

  return (
    <nav className="bottom-nav" aria-label={t('nav.base')}>
      {NAV_ITEMS.map((item) => {
        const isActive = item === 'base';
        return (
          <button
            key={item}
            type="button"
            className={`bottom-nav__item${isActive ? ' bottom-nav__item--active' : ''}`}
            disabled={!isActive}
            aria-current={isActive ? 'page' : undefined}
          >
            {t(`nav.${item}`)}
          </button>
        );
      })}
    </nav>
  );
}
