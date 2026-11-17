import type { ComponentVerdict, SupplyRecordEval, SupplyRecordStatus } from '../types';
import { RECORD_STATUS_LABEL, VERDICT_LABEL } from '../lib/supplyExport';
import { mealLabel, schoolLabel } from '../engine/supplyEngine';

const VERDICT_CLASS: Record<ComponentVerdict, string> = {
  CONTAINS: 'unknown',
  NOT_FOUND: 'ok',
  UNKNOWN: 'candidate',
};

export function VerdictBadge({ verdict }: { verdict: ComponentVerdict }) {
  return <span className={`badge ${VERDICT_CLASS[verdict]}`}>{VERDICT_LABEL[verdict]}</span>;
}

const STATUS_CLASS: Record<SupplyRecordStatus, string> = {
  ACTUAL: 'confirmed',
  CLOSED: 'neutral',
  ZERO_SERVED: 'neutral',
  GAP: 'issue',
};

export function RecordStatusBadge({ status }: { status: SupplyRecordStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{RECORD_STATUS_LABEL[status]}</span>;
}

/** 分层堆叠条：确认含有 / 未发现 / 无法判定（按实际供餐记录数） */
export function StratumStackedBar({
  contains,
  notFound,
  unknown,
}: {
  contains: number;
  notFound: number;
  unknown: number;
}) {
  const total = contains + notFound + unknown;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div>
      <div className="bar-stack" title={`含有 ${contains} / 未发现 ${notFound} / 未知 ${unknown}`}>
        <div className="seg-unknown" style={{ width: `${pct(contains)}%` }} />
        <div className="seg-confirmed" style={{ width: `${pct(notFound)}%` }} />
        <div className="seg-candidate" style={{ width: `${pct(unknown)}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        共 {total} 条实际供餐：含有 {contains} · 未发现 {notFound} · 未知 {unknown}
      </div>
    </div>
  );
}

/** 边界区间条：未知记录不同取值下的下界/上界（非置信区间） */
export function IntervalBar({ lower, upper }: { lower: number; upper: number }) {
  const l = lower * 100;
  const u = upper * 100;
  return (
    <div className="interval-wrap" title={`下界 ${l.toFixed(1)}%，上界 ${u.toFixed(1)}%`}>
      <div className="interval-track">
        <div className="interval-fill" style={{ left: `${l}%`, width: `${Math.max(u - l, 0.8)}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        [{l.toFixed(1)}%, {u.toFixed(1)}%]
      </div>
    </div>
  );
}

export function recordLabel(r: SupplyRecordEval): string {
  return `${schoolLabel(r.schoolId)} ${r.serviceWindow} · ${r.bizDate} · ${mealLabel(r.mealType)}`;
}
