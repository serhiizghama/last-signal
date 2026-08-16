import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { FACTIONS, type Faction } from '../api/types';

interface FactionPickerProps {
  value: Faction | undefined;
  onChange: (faction: Faction) => void;
}

export function FactionPicker({ value, onChange }: FactionPickerProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="faction-picker" role="radiogroup" aria-label={t('register.factionLabel')}>
      {FACTIONS.map((faction) => {
        const selected = faction === value;
        return (
          <button
            key={faction}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`faction-card${selected ? ' faction-card--selected' : ''}`}
            onClick={() => onChange(faction)}
          >
            <span className="faction-card__name">{t(`factions.${faction}.name`)}</span>
            <span className="faction-card__description">
              {t(`factions.${faction}.description`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
