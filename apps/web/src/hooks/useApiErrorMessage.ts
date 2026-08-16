import { useTranslation } from 'react-i18next';

import { translateApiError } from '../i18n/apiError';

/** Translates a thrown value (typically an `ApiError`) into Russian text via i18next. */
export function useApiErrorMessage(error: unknown): string {
  const { i18n } = useTranslation();
  return translateApiError(i18n, error);
}
