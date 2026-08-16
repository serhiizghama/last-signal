import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiErrorMessage } from '../hooks/useApiErrorMessage';

/** A neutral loading state — every async screen shows this instead of a bare/invisible spinner. */
export function LoadingPanel(): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="panel" role="status">
      {t('actions.loading')}
    </p>
  );
}

interface ErrorPanelProps {
  error: unknown;
  onRetry?: () => void;
}

/** A failed async screen — always shows translated Russian text, never a raw key or exception message. */
export function ErrorPanel({ error, onRetry }: ErrorPanelProps): ReactElement {
  const { t } = useTranslation();
  const message = useApiErrorMessage(error);

  return (
    <div className="panel panel--danger" role="alert">
      <p className="panel__row">{message}</p>
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          {t('actions.retry')}
        </button>
      )}
    </div>
  );
}
