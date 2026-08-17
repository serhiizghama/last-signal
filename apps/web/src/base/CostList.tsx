import type { ReactElement } from 'react';
import type { Resources } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

interface CostListProps {
  cost: Resources;
}

/** A resource-cost preview, shared by the build cost (`BuildingList`) and the training batch cost (`TrainingSection`). */
export function CostList({ cost }: CostListProps): ReactElement {
  const { t: tResources } = useTranslation('resources');
  const entries = Object.entries(cost).filter(([, amount]) => amount > 0);
  return (
    <ul className="building-card__cost">
      {entries.map(([kind, amount]) => (
        <li key={kind}>
          {tResources(kind as keyof typeof cost)} {amount.toLocaleString('ru-RU')}
        </li>
      ))}
    </ul>
  );
}
