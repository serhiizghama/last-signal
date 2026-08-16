import type { ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { createSettlement } from '../api/endpoints';
import { SETTLEMENTS_MINE_KEY } from '../base/settlementCache';
import { ErrorPanel } from '../components/StatusPanels';

/** Shown once the account is registered but owns no settlement yet. */
export function CreateSettlementScreen(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () => createSettlement(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETTLEMENTS_MINE_KEY });
    },
  });

  return (
    <div className="panel screen">
      <h2 className="screen__title">{t('createSettlement.title')}</h2>
      <p className="screen__description">{t('createSettlement.description')}</p>

      <button
        type="button"
        className="button button--primary"
        disabled={createMutation.isPending}
        onClick={() => createMutation.mutate()}
      >
        {createMutation.isPending ? t('actions.submitting') : t('createSettlement.submit')}
      </button>

      {createMutation.isError && <ErrorPanel error={createMutation.error} />}
    </div>
  );
}
