import type { ReactElement } from 'react';
import { formatDuration } from '@last-signal/game-core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiErrorMessage } from './hooks/useApiErrorMessage';
import { useCountdownWindow } from './hooks/useServerClock';
import { Onboarding } from './onboarding/Onboarding';
import { queryClient } from './queryClient';
import { useHealth } from './useHealth';

const COUNTDOWN_WINDOW_MS = 60_000;

function ConnectionBadge(): ReactElement {
  const { t } = useTranslation();
  const health = useHealth();
  const serverTime = health.state === 'ok' ? health.data.serverTime : undefined;
  const remainingMs = useCountdownWindow(serverTime, COUNTDOWN_WINDOW_MS);
  const connectionErrorMessage = useApiErrorMessage(
    health.state === 'error' ? health.error : undefined,
  );

  return (
    <header className="app__header">
      <h1 className="app__title">{t('app.title')}</h1>
      <span className={`status status--${health.state}`}>{t(`health.${health.state}`)}</span>

      {health.state === 'ok' && (
        <p className="app__clock">
          {t('health.coreVersion', { version: health.data.gameCoreVersion })} ·{' '}
          {t('health.nextSignal')}{' '}
          <strong className="countdown">{formatDuration(remainingMs ?? 0)}</strong>
        </p>
      )}
      {health.state === 'error' && (
        <p className="panel panel--danger">
          {t('health.connectionError', { message: connectionErrorMessage })}
        </p>
      )}
    </header>
  );
}

export function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <ConnectionBadge />
        <main className="app__main">
          <Onboarding />
        </main>
      </div>
    </QueryClientProvider>
  );
}
