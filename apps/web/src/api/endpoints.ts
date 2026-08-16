import type { BuildingType } from '@last-signal/game-core';

import { apiClient } from './client';
import type { AccountView, RegisterInput, SettlementStateView } from './types';

export function fetchMe(signal?: AbortSignal): Promise<AccountView> {
  return apiClient.get<AccountView>('/auth/me', signal);
}

export function loginAsGuest(signal?: AbortSignal): Promise<AccountView> {
  return apiClient.post<AccountView>('/auth/guest', undefined, signal);
}

export function logout(signal?: AbortSignal): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>('/auth/logout', undefined, signal);
}

export function register(input: RegisterInput, signal?: AbortSignal): Promise<AccountView> {
  return apiClient.post<AccountView>('/accounts/register', input, signal);
}

export function createSettlement(signal?: AbortSignal): Promise<SettlementStateView> {
  return apiClient.post<SettlementStateView>('/settlements', undefined, signal);
}

export function fetchMySettlements(signal?: AbortSignal): Promise<SettlementStateView[]> {
  return apiClient.get<SettlementStateView[]>('/settlements/mine', signal);
}

export function fetchSettlement(id: string, signal?: AbortSignal): Promise<SettlementStateView> {
  return apiClient.get<SettlementStateView>(`/settlements/${id}`, signal);
}

export function startBuild(
  id: string,
  type: BuildingType,
  signal?: AbortSignal,
): Promise<SettlementStateView> {
  return apiClient.post<SettlementStateView>(`/settlements/${id}/build`, { type }, signal);
}

export function cancelBuild(
  id: string,
  queueItemId: string,
  signal?: AbortSignal,
): Promise<SettlementStateView> {
  return apiClient.post<SettlementStateView>(
    `/settlements/${id}/build/${queueItemId}/cancel`,
    undefined,
    signal,
  );
}
