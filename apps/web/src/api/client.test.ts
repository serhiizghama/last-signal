import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient, ApiError } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClient', () => {
  it('always sends credentials: include, so the httpOnly session cookie rides along', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.get('/auth/me');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('never hardcodes an origin — only relative /api paths are requested', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(jsonResponse({})),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.post('/accounts/register', { name: 'x', faction: 'raiders' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/accounts/register');
  });

  it('parses a successful response as JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ id: '1', name: 'Скиталец' }))),
    );

    const result = await apiClient.get<{ id: string; name: string }>('/auth/me');
    expect(result).toEqual({ id: '1', name: 'Скиталец' });
  });

  it('converts a non-2xx { error: { key, params } } body into a typed ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { key: 'errors.account.nameTaken', params: { name: 'x' } } }, 409),
        ),
      ),
    );

    await expect(apiClient.post('/accounts/register', {})).rejects.toMatchObject({
      key: 'errors.account.nameTaken',
      params: { name: 'x' },
      status: 409,
    });
    await expect(apiClient.post('/accounts/register', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to the generic key when a non-2xx body cannot be parsed as an error shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ unexpected: true }, 500))),
    );

    await expect(apiClient.get('/health')).rejects.toMatchObject({
      key: 'errors.generic',
      status: 500,
    });
  });

  it('falls back to the generic key on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(apiClient.get('/health')).rejects.toMatchObject({
      key: 'errors.generic',
      status: 0,
    });
  });

  it('propagates an AbortError untouched instead of wrapping it in an ApiError', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort();
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }),
    );

    await expect(apiClient.get('/health', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
