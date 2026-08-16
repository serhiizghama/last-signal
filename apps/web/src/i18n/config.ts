import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import buildingsRu from './locales/ru/buildings.json';
import commonRu from './locales/ru/common.json';
import errorsRu from './locales/ru/errors.json';
import resourcesRu from './locales/ru/resources.json';

/**
 * Russian is the only shipped locale for now (English lands in M6). Namespaces mirror the
 * game's domains so a screen only pulls in the strings it actually needs.
 */
export const defaultNS = 'common';

export const resources = {
  ru: {
    common: commonRu,
    buildings: buildingsRu,
    resources: resourcesRu,
    errors: errorsRu,
  },
} as const;

void i18next.use(initReactI18next).init({
  lng: 'ru',
  fallbackLng: 'ru',
  defaultNS,
  ns: Object.keys(resources.ru),
  resources,
  // React already escapes interpolated values; double-escaping breaks things like em-dashes.
  interpolation: { escapeValue: false },
  // A missing key returns the key itself (never `null`) so a bug is visible, not blank.
  returnNull: false,
});

export default i18next;
