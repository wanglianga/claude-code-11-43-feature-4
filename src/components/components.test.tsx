import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverageBar, CoverageDonut } from './Coverage';
import { BucketBadge, MatchBadge, FieldStatusBadge } from './Badges';
import type { CoverageCounts } from '../types';

const coverage: CoverageCounts = { total: 24, confirmed: 4, candidatePending: 1, unknownMissing: 19 };

describe('展示组件渲染冒烟（Node SSR）', () => {
  it('覆盖条与环形图按三桶数据渲染', () => {
    const bar = renderToStaticMarkup(<CoverageBar coverage={coverage} />);
    expect(bar).toContain('seg-confirmed');
    expect(bar).toContain('共 24 条领餐');
    const donut = renderToStaticMarkup(<CoverageDonut coverage={coverage} />);
    expect(donut).toContain('conic-gradient');
    expect(donut).toContain('来源缺失未知（19');
  });

  it('三类徽标渲染正确文案', () => {
    expect(renderToStaticMarkup(<BucketBadge bucket="CONFIRMED" />)).toContain('有证据支持的匹配');
    expect(renderToStaticMarkup(<BucketBadge bucket="CANDIDATE_PENDING" />)).toContain('存在候选但需确认');
    expect(renderToStaticMarkup(<BucketBadge bucket="UNKNOWN_MISSING" />)).toContain('来源缺失无法判定');
    expect(renderToStaticMarkup(<MatchBadge kind="APPROVED_ALIAS" />)).toContain('已批准别名');
    expect(renderToStaticMarkup(<FieldStatusBadge status="BATCH_PENDING" />)).toContain('来源批次尚未到齐');
  });
});
