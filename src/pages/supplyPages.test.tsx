import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { loadTestDataset } from '../test/loadTestDataset';
import { runSupplyAnalysis, DEFAULT_FILTERS, DEFAULT_COMPARISON_SCHEME } from '../engine/supplyEngine';
import type { Dataset } from '../lib/loadDataset';
import type { SupplyAnalysis } from '../types';

const dataset: Dataset = await loadTestDataset();
const analysis: SupplyAnalysis = runSupplyAnalysis(dataset, dataset.seedMapping, {
  allergen: '乳',
  filters: DEFAULT_FILTERS,
  activatedLateBatches: [],
  scheme: DEFAULT_COMPARISON_SCHEME,
  mappingRevision: 1,
});

// 以真实计算结果模拟 AppState，渲染页面做冒烟检查
vi.mock('../state/AppState', () => ({
  useAppState: () => ({
    dataset,
    currentSupply: analysis,
    supplyFilters: DEFAULT_FILTERS,
    setSupplyFilters: () => {},
    supplyAllergen: '乳',
    setSupplyAllergen: () => {},
    comparisonScheme: DEFAULT_COMPARISON_SCHEME,
    supplyActivation: { activated: [], revision: 1, modifiedAt: '' },
    supplyStale: null,
    supplyRuns: [],
    saveSupplyRun: async () => ({}),
    removeSupplyRun: async () => {},
    activateLateBatch: async () => {},
    applyRemoteActivation: async () => {},
    dismissSupplyStale: () => {},
    mappingState: { doc: dataset.seedMapping, revision: 1, lastModifiedAt: '' },
  }),
}));

const { SupplyPage } = await import('./SupplyPage');
const { SchoolComparePage } = await import('./SchoolComparePage');

describe('供餐指标与跨校比较页面渲染冒烟', () => {
  it('SupplyPage 渲染总体核对、分层指标与记录明细', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SupplyPage />
      </MemoryRouter>,
    );
    expect(html).toContain('供餐指标');
    expect(html).toContain('总体核对');
    expect(html).toContain('分层指标');
    expect(html).toContain('甲校');
    expect(html).toContain('乙校');
    expect(html).toContain('未解释缺口');
    expect(html).toContain('确认含有');
  });

  it('SchoolComparePage 渲染参照构成、调整值与辛普森反转提示', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SchoolComparePage />
      </MemoryRouter>,
    );
    expect(html).toContain('跨校比较');
    expect(html).toContain('固定参照构成');
    expect(html).toContain('34.0%'); // 甲校调整值
    expect(html).toContain('47.3%'); // 乙校调整值
    expect(html).toContain('餐别内顺序与合并顺序相反');
    expect(html).toContain('不强行给出确定的高低结论');
  });
});
