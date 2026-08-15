import type { ResourceKind } from '@last-signal/game-core';
import { formatDuration, msUntil, RESOURCE_KINDS } from '@last-signal/game-core';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import type { HealthState } from './useHealth';
import { useHealth } from './useHealth';

const COUNTDOWN_WINDOW_MS = 60_000;
const TICK_INTERVAL_MS = 1000;

const RESOURCE_LABELS: Record<ResourceKind, string> = {
  scrap: 'Металлолом',
  fuel: 'Топливо',
  electronics: 'Электроника',
  food: 'Еда',
};

// Placeholder values only — real resource stocks arrive with the game state
// API in a later milestone.
const PLACEHOLDER_RESOURCE_VALUES: Record<ResourceKind, number> = {
  scrap: 120,
  fuel: 45,
  electronics: 8,
  food: 76,
};

const STATUS_LABELS: Record<HealthState['state'], string> = {
  loading: 'Подключение…',
  ok: 'Онлайн',
  error: 'Нет связи',
};

/**
 * Counts down to `serverTime + windowMs`. The "now" used on every tick is
 * derived from `serverTime` plus elapsed monotonic client time (measured with
 * `performance.now()`, the same technique the server uses for its own
 * `uptimeMs`), never from the browser's wall clock — the countdown reflects
 * the server's notion of time, not the device's.
 */
function useCountdown(serverTime: number | undefined, windowMs: number): number | undefined {
  const [remainingMs, setRemainingMs] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (serverTime === undefined) {
      setRemainingMs(undefined);
      return;
    }

    const dueAt = serverTime + windowMs;
    const anchoredAtClientMs = performance.now();

    const tick = (): void => {
      const estimatedServerNow = serverTime + (performance.now() - anchoredAtClientMs);
      setRemainingMs(msUntil(estimatedServerNow, dueAt));
    };

    tick();
    const intervalId = setInterval(tick, TICK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [serverTime, windowMs]);

  return remainingMs;
}

export function App(): ReactElement {
  const health = useHealth();
  const serverTime = health.state === 'ok' ? health.data.serverTime : undefined;
  const remainingMs = useCountdown(serverTime, COUNTDOWN_WINDOW_MS);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">ПОСЛЕДНИЙ СИГНАЛ</h1>
        <span className={`status status--${health.state}`}>{STATUS_LABELS[health.state]}</span>
      </header>

      <ul className="resource-bar" aria-label="Ресурсы">
        {RESOURCE_KINDS.map((kind) => (
          <li key={kind} className="resource-bar__item">
            <span className="resource-bar__label">{RESOURCE_LABELS[kind]}</span>
            <span className="resource-bar__value">{PLACEHOLDER_RESOURCE_VALUES[kind]}</span>
          </li>
        ))}
      </ul>

      <main className="app__main">
        {health.state === 'loading' && <p className="panel">Устанавливаем связь с сервером…</p>}

        {health.state === 'error' && (
          <p className="panel panel--danger">Ошибка соединения: {health.message}</p>
        )}

        {health.state === 'ok' && (
          <div className="panel panel--ok">
            <p className="panel__row">
              Версия ядра: <strong>{health.data.gameCoreVersion}</strong>
            </p>
            <p className="panel__row">
              До следующего сигнала:{' '}
              <strong className="countdown">{formatDuration(remainingMs ?? 0)}</strong>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
