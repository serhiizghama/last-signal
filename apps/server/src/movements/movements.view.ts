import type { MovementDocument, MovementStatus, MovementType } from '../schemas/movement.schema';
import type { UnitCountEntry } from './movements.util';

// The client's countdowns are driven from `serverTime` + `arriveAt`/`returnAt`, run locally,
// and never trust the client's own clock — same convention as `SettlementStateView`'s own
// `serverTime` field (`settlements/settlements.view.ts`).
export interface MovementView {
  id: string;
  type: MovementType;
  fromSettlementId: string;
  toSettlementId: string;
  target: { x: number; y: number };
  units: UnitCountEntry[];
  survivors: UnitCountEntry[];
  departAt: number;
  arriveAt: number;
  returnAt: number | null;
  status: MovementStatus;
  serverTime: number;
}

// Pure reshape of a persisted movement document into the wire view model — mirrors
// `buildSettlementStateView`'s own "nothing here is computed by hand" convention, just with
// no game-core formulas to call (a movement's own fields are already the whole view).
export function toMovementView(doc: MovementDocument, now: number): MovementView {
  return {
    id: String(doc._id),
    type: doc.type,
    fromSettlementId: String(doc.fromSettlementId),
    toSettlementId: String(doc.toSettlementId),
    target: { x: doc.target.x, y: doc.target.y },
    units: doc.units.map((u) => ({ unitType: u.unitType, count: u.count })),
    survivors: doc.survivors.map((u) => ({ unitType: u.unitType, count: u.count })),
    departAt: doc.departAt,
    arriveAt: doc.arriveAt,
    returnAt: doc.returnAt,
    status: doc.status,
    serverTime: now,
  };
}
