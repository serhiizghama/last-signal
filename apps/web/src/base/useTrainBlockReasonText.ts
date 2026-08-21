import { useTranslation } from 'react-i18next';

import type { TrainBlockReason } from './trainEligibility';

/**
 * Translates a `TrainBlockReason` through the same `errors.training.*` keys the server itself
 * rejects with (§7/§11) — client and server never disagree on the wording. Shared by the
 * Barracks card (`TrainingSection`) and the Units tab's roster (M3e.2, `TrainingBuildingCard`)
 * so both surfaces show the exact same reason text for the exact same reason.
 */
export function useTrainBlockReasonText(block: TrainBlockReason | undefined): string | undefined {
  const { t: tErrors } = useTranslation('errors');
  if (!block) {
    return undefined;
  }
  switch (block.kind) {
    case 'noFaction':
      return tErrors('training.noFaction');
    case 'wrongFaction':
      return tErrors('training.wrongFaction');
    case 'buildingMissing':
      return tErrors('training.buildingMissing');
    case 'queueBusy':
      return tErrors('training.queueBusy');
    case 'wouldStarve':
      return tErrors('training.wouldStarve');
    case 'insufficientResources':
      return tErrors('training.insufficientResources');
  }
}
