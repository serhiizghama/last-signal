import type { ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { loginAsGuest } from '../api/endpoints';
import { ErrorPanel } from '../components/StatusPanels';

/** Shown when `GET /api/auth/me` comes back 401: no session yet. */
export function WelcomeScreen(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const guestLogin = useMutation({
    mutationFn: () => loginAsGuest(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <div className="panel screen">
      <h2 className="screen__title">{t('welcome.title')}</h2>
      <p className="screen__description">{t('welcome.description')}</p>

      <button
        type="button"
        className="button button--primary"
        disabled={guestLogin.isPending}
        onClick={() => guestLogin.mutate()}
      >
        {guestLogin.isPending ? t('actions.submitting') : t('welcome.playAsGuest')}
      </button>

      {guestLogin.isError && <ErrorPanel error={guestLogin.error} />}
    </div>
  );
}
