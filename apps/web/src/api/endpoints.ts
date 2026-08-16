import type { BuildingType } from '@last-signal/game-core';

import { apiClient } from './client';
import type {
  AccountView,
  MapView,
  MovementView,
  RegisterInput,
  ReportsPageView,
  ReportView,
  SendScoutsInput,
  SettlementStateView,
} from './types';

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

export function fetchMap(signal?: AbortSignal): Promise<MapView> {
  return apiClient.get<MapView>('/map', signal);
}

export function fetchMyMovements(signal?: AbortSignal): Promise<MovementView[]> {
  return apiClient.get<MovementView[]>('/movements/mine', signal);
}

export function sendScouts(input: SendScoutsInput, signal?: AbortSignal): Promise<MovementView> {
  return apiClient.post<MovementView>('/movements', input, signal);
}

export function cancelMovement(id: string, signal?: AbortSignal): Promise<MovementView> {
  return apiClient.post<MovementView>(`/movements/${id}/cancel`, undefined, signal);
}

export interface FetchReportsParams {
  cursor?: string;
  limit?: number;
}

export function fetchReports(
  params: FetchReportsParams = {},
  signal?: AbortSignal,
): Promise<ReportsPageView> {
  const query = new URLSearchParams();
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  const queryString = query.toString();
  return apiClient.get<ReportsPageView>(`/reports${queryString ? `?${queryString}` : ''}`, signal);
}

// Read-on-open (§8): the server marks the report read as a side effect of this same GET — see
// `ReportsService.getAndMarkRead`'s own comment for why there is no separate mark-read route.
export function fetchReport(id: string, signal?: AbortSignal): Promise<ReportView> {
  return apiClient.get<ReportView>(`/reports/${id}`, signal);
}
