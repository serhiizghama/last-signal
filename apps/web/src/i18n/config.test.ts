import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import i18n from './config';
import { translateApiError } from './apiError';

describe('i18n config', () => {
  it('loads the RU common bundle', () => {
    expect(i18n.language).toBe('ru');
    expect(i18n.t('app.title')).toBe('ПОСЛЕДНИЙ СИГНАЛ');
  });

  it('loads the buildings, resources and errors namespaces', () => {
    expect(i18n.t('commandCenter.name', { ns: 'buildings' })).toBe('Штаб');
    expect(i18n.t('scrap', { ns: 'resources' })).toBe('Металлолом');
    expect(i18n.t('auth.notAuthenticated', { ns: 'errors' })).toBe(
      'Сессия истекла. Нужно войти заново.',
    );
  });

  it('loads the reports namespace', () => {
    expect(i18n.t('title', { ns: 'reports' })).toBe('Отчёты');
  });

  it('renders the correct Russian plural form for 1 / 3 / 5', () => {
    expect(i18n.t('base.buildingsCount', { count: 1 })).toBe('1 постройка');
    expect(i18n.t('base.buildingsCount', { count: 3 })).toBe('3 постройки');
    expect(i18n.t('base.buildingsCount', { count: 5 })).toBe('5 построек');
  });

  it('falls back to the generic message for an unknown server error key', () => {
    const error = new ApiError('errors.thisKeyDoesNotExist', {}, 400);
    expect(translateApiError(i18n, error)).toBe(i18n.t('generic', { ns: 'errors' }));
    expect(translateApiError(i18n, error)).not.toContain('thisKeyDoesNotExist');
  });

  it('translates a known server error key with its params interpolated', () => {
    const error = new ApiError('errors.account.nameTaken', { name: 'Скиталец' }, 409);
    expect(translateApiError(i18n, error)).toBe('Позывной «Скиталец» уже занят.');
  });

  it('falls back to the generic message for a non-ApiError value', () => {
    expect(translateApiError(i18n, new Error('boom'))).toBe(i18n.t('generic', { ns: 'errors' }));
  });
});
