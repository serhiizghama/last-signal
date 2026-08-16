import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import buildingsRu from './locales/ru/buildings.json';
import commonRu from './locales/ru/common.json';
import errorsRu from './locales/ru/errors.json';
import mapRu from './locales/ru/map.json';
import reportsRu from './locales/ru/reports.json';
import resourcesRu from './locales/ru/resources.json';
import unitsRu from './locales/ru/units.json';

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
    map: mapRu,
    // Reserved by M1 §15, filled in by M2c.2's send-scout flow and movements overlay (unit
    // names for the three faction scouts — the only units the catalogue has until M3).
    units: unitsRu,
    // Reserved by M1 §15, filled in by M2c.3's Reports tab (§8/§11): every scout-report string
    // the client renders from the server's structured `payload`.
    reports: reportsRu,
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
