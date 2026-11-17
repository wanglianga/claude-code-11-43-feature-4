import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntervalBar, RecordStatusBadge, StratumStackedBar, VerdictBadge } from './SupplyViz';

describe('供餐指标展示组件渲染冒烟（Node SSR）', () => {
  it('判断徽标与状态徽标渲染正确文案', () => {
    expect(renderToStaticMarkup(<VerdictBadge verdict="CONTAINS" />)).toContain('确认含有');
    expect(renderToStaticMarkup(<VerdictBadge verdict="NOT_FOUND" />)).toContain('未发现');
    expect(renderToStaticMarkup(<VerdictBadge verdict="UNKNOWN" />)).toContain('无法判定');
    expect(renderToStaticMarkup(<RecordStatusBadge status="ACTUAL" />)).toContain('实际供餐');
    expect(renderToStaticMarkup(<RecordStatusBadge status="CLOSED" />)).toContain('明确停业');
    expect(renderToStaticMarkup(<RecordStatusBadge status="ZERO_SERVED" />)).toContain('明确零供餐');
    expect(renderToStaticMarkup(<RecordStatusBadge status="GAP" />)).toContain('未解释缺口');
  });

  it('分层堆叠条与边界区间条渲染', () => {
    const bar = renderToStaticMarkup(<StratumStackedBar contains={3} notFound={5} unknown={2} />);
    expect(bar).toContain('seg-unknown');
    expect(bar).toContain('seg-confirmed');
    expect(bar).toContain('seg-candidate');
    expect(bar).toContain('共 10 条实际供餐');
    const interval = renderToStaticMarkup(<IntervalBar lower={0.34} upper={0.52} />);
    expect(interval).toContain('34.0%');
    expect(interval).toContain('52.0%');
  });
});
