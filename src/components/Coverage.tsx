import type { CSSProperties } from 'react';
import type { CoverageCounts } from '../types';

export function CoverageBar({ coverage }: { coverage: CoverageCounts }) {
  const { total, confirmed, candidatePending, unknownMissing } = coverage;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div>
      <div className="bar-stack" title={`确认 ${confirmed} / 候选 ${candidatePending} / 未知 ${unknownMissing}`}>
        <div className="seg-confirmed" style={{ width: `${pct(confirmed)}%` }} />
        <div className="seg-candidate" style={{ width: `${pct(candidatePending)}%` }} />
        <div className="seg-unknown" style={{ width: `${pct(unknownMissing)}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        共 {total} 条领餐：确认 {confirmed} · 候选 {candidatePending} · 未知 {unknownMissing}
      </div>
    </div>
  );
}

export function CoverageDonut({ coverage }: { coverage: CoverageCounts }) {
  const { total, confirmed, candidatePending, unknownMissing } = coverage;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  const c = pct(confirmed);
  const p = pct(candidatePending);
  const u = pct(unknownMissing);
  const style: CSSProperties = {
    background: `conic-gradient(
      var(--confirmed) 0 ${c}%,
      var(--candidate) ${c}% ${c + p}%,
      var(--unknown) ${c + p}% ${c + p + u}%,
      var(--surface-2) ${c + p + u}% 100%)`,
  };
  return (
    <div className="donut-wrap">
      <div className="donut" style={style} />
      <div className="legend">
        <span><span className="dot" style={{ background: 'var(--confirmed)' }} />有证据支持（{confirmed}，{c.toFixed(1)}%）</span>
        <span><span className="dot" style={{ background: 'var(--candidate)' }} />候选待确认（{candidatePending}，{p.toFixed(1)}%）</span>
        <span><span className="dot" style={{ background: 'var(--unknown)' }} />来源缺失未知（{unknownMissing}，{u.toFixed(1)}%）</span>
      </div>
    </div>
  );
}
