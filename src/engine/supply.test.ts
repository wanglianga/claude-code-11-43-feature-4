import { describe, expect, it } from 'vitest';
import { loadTestDataset } from '../test/loadTestDataset';
import {
  DEFAULT_COMPARISON_SCHEME,
  DEFAULT_FILTERS,
  buildSupplyRecords,
  computeSchoolIndicator,
  previewLateBatch,
  runSupplyAnalysis,
} from './supplyEngine';
import type { SupplyFilters } from '../types';

const dataset = await loadTestDataset();
const mapping = dataset.seedMapping;
const OPTS = { allergen: '乳', filters: DEFAULT_FILTERS, activatedLateBatches: [] as string[], mappingRevision: 1 };

const analysis = runSupplyAnalysis(dataset, mapping, OPTS);
const schoolA = analysis.schools.find((s) => s.schoolId === 'A')!;
const schoolB = analysis.schools.find((s) => s.schoolId === 'B')!;

describe('供餐记录构建与去重', () => {
  const { records } = buildSupplyRecords(dataset, DEFAULT_FILTERS, []);

  it('统计单位=学校+窗口+业务日+餐别，多段开放与重复上报不复制记录', () => {
    const a0901b = records.find((r) => r.key === 'A|W1|2026-09-01|breakfast')!;
    expect(a0901b.status).toBe('ACTUAL');
    expect(a0901b.segments.length).toBe(2); // 两段开放时间合并为同一记录
    expect(a0901b.dedup.rawLogRows).toBe(3); // 3 行原始日志
    expect(a0901b.dedup.duplicatesRemoved).toBe(1); // 1 行重复上报被去重
    const b0902l = records.find((r) => r.key === 'B|W1|2026-09-02|lunch')!;
    expect(b0902l.dedup.duplicatesRemoved).toBe(1);
  });

  it('登记表重叠调整单去重，不复制应覆盖组合', () => {
    const a0904b = records.find((r) => r.key === 'A|W1|2026-09-04|breakfast')!;
    expect(a0904b.dedup.registryOverlap).toBe(true);
    // 甲校 W1 早餐 9/1-9/5 只产生 5 条记录（重叠调整单不复制）
    expect(records.filter((r) => r.schoolId === 'A' && r.serviceWindow === 'W1' && r.mealType === 'breakfast')).toHaveLength(5);
  });

  it('总体核对：甲校缺口未闭合，乙校完整；停业/零供餐不计入分母', () => {
    const a = computeSchoolIndicator('A', records, DEFAULT_FILTERS.mealTypes);
    const b = computeSchoolIndicator('B', records, DEFAULT_FILTERS.mealTypes);
    expect(a.reconciliation).toMatchObject({ expected: 25, actual: 20, closedZero: 0, gaps: 5, complete: false });
    expect(b.reconciliation).toMatchObject({ expected: 20, actual: 17, closedZero: 3, gaps: 0, complete: true });
    // 甲校缺口全部来自 W2 晚餐（计划开餐行不能证明供餐）
    expect(a.reconciliation.gapKeys.every((k) => k.includes('W2') && k.includes('dinner'))).toBe(true);
    const gap = records.find((r) => r.key === 'A|W2|2026-09-01|dinner')!;
    expect(gap.status).toBe('GAP');
    expect(gap.plannedLogRowIds.length).toBe(1);
    expect(gap.inclusionReason).toContain('计划开餐表不能证明');
    // 乙校明确停业 2 + 明确零供餐 1
    const zero = records.find((r) => r.key === 'B|W2|2026-09-04|dinner')!;
    expect(zero.status).toBe('ZERO_SERVED');
    const closed = records.filter((r) => r.status === 'CLOSED');
    expect(closed).toHaveLength(2);
  });

  it('真正不存在的餐别不在应覆盖范围（甲 W2 午餐、乙 W2 早餐/午餐）', () => {
    expect(records.some((r) => r.serviceWindow === 'W2' && r.mealType === 'lunch')).toBe(false);
    expect(records.some((r) => r.schoolId === 'B' && r.serviceWindow === 'W2' && r.mealType === 'breakfast')).toBe(false);
  });
});

describe('成分判断（针对选定过敏原，按供餐记录计算）', () => {
  it('部分原料未知但已有一条充分含有依据时仍可确认含有', () => {
    const rec = analysis.records.find((r) => r.key === 'A|W1|2026-09-03|breakfast')!;
    expect(rec.judgment?.verdict).toBe('CONTAINS'); // 牛奶含有乳，神秘调料未解析不清空判断
    expect(rec.judgment?.positiveRows).toHaveLength(1);
    expect(rec.judgment?.unknownRows).toHaveLength(1);
  });

  it('只有完整到足以排除的资料才可归入未发现；部分未知则保持未知', () => {
    const notFound = analysis.records.find((r) => r.key === 'A|W1|2026-09-02|dinner')!;
    expect(notFound.judgment?.verdict).toBe('NOT_FOUND');
    const partial = analysis.records.find((r) => r.key === 'A|W1|2026-09-01|dinner')!;
    expect(partial.judgment?.verdict).toBe('UNKNOWN'); // 神秘调料未解析，不能默认不含
  });

  it('有实际发餐但用料缺失的记录进入未知，缺报不默认不含', () => {
    const missing = analysis.records.find((r) => r.key === 'A|W1|2026-09-04|dinner')!;
    expect(missing.judgment?.verdict).toBe('UNKNOWN');
    expect(missing.judgment?.reasons.join('')).toContain('用料缺失');
  });

  it('计划使用行不计入判断', () => {
    const rec = analysis.records.find((r) => r.key === 'A|W1|2026-09-04|lunch')!;
    expect(rec.judgment?.plannedExcluded).toBe(1);
    expect(rec.judgment?.verdict).toBe('CONTAINS'); // 牛奶含有乳
  });
});

describe('分层指标与辛普森反转（乳）', () => {
  it('餐别内比例：三个餐别均为乙校高于甲校', () => {
    const aB = schoolA.strata.find((s) => s.mealType === 'breakfast')!;
    const bB = schoolB.strata.find((s) => s.mealType === 'breakfast')!;
    expect(aB).toMatchObject({ actual: 10, verified: 10, contains: 6 });
    expect(bB).toMatchObject({ actual: 3, verified: 3, contains: 2 });
    expect(aB.verifiedRatio!).toBeCloseTo(0.6, 5);
    expect(bB.verifiedRatio!).toBeCloseTo(2 / 3, 5);

    const aL = schoolA.strata.find((s) => s.mealType === 'lunch')!;
    const bL = schoolB.strata.find((s) => s.mealType === 'lunch')!;
    expect(aL).toMatchObject({ actual: 5, contains: 2 });
    expect(bL).toMatchObject({ actual: 5, contains: 3 });

    const aD = schoolA.strata.find((s) => s.mealType === 'dinner')!;
    const bD = schoolB.strata.find((s) => s.mealType === 'dinner')!;
    expect(aD).toMatchObject({ actual: 5, verified: 2, contains: 0, unknown: 3 });
    expect(bD).toMatchObject({ actual: 9, verified: 9, contains: 1 });
    [0, 1, 2].forEach((i) => {
      expect(schoolA.strata[i].verifiedRatio!).toBeLessThan(schoolB.strata[i].verifiedRatio!);
    });
  });

  it('合并后顺序相反：甲校已核实合并比例高于乙校', () => {
    expect(schoolA.totals).toMatchObject({ actual: 20, verified: 17, contains: 8, unknown: 3 });
    expect(schoolB.totals).toMatchObject({ actual: 17, verified: 17, contains: 6, unknown: 0 });
    expect(schoolA.verifiedRatioMerged!).toBeCloseTo(8 / 17, 5);
    expect(schoolB.verifiedRatioMerged!).toBeCloseTo(6 / 17, 5);
    expect(schoolA.verifiedRatioMerged!).toBeGreaterThan(schoolB.verifiedRatioMerged!);
  });

  it('总体完整才给边界：乙校 [6/17, 6/17]，甲校因缺口不套用公式', () => {
    expect(schoolB.bounds).not.toBeNull();
    expect(schoolB.bounds!.lower).toBeCloseTo(6 / 17, 5);
    expect(schoolB.bounds!.upper).toBeCloseTo(6 / 17, 5);
    expect(schoolA.bounds).toBeNull();
    expect(schoolA.boundsBlockedReason).toContain('未解释缺口');
  });

  it('直接标准化：同一参照结构下调整值反转合并顺序，但边界重叠不强行结论', () => {
    const cmp = analysis.comparison;
    expect(cmp.effectiveWeights).toEqual({ breakfast: 0.3, lunch: 0.4, dinner: 0.3 });
    const a = cmp.schools.find((s) => s.schoolId === 'A')!;
    const b = cmp.schools.find((s) => s.schoolId === 'B')!;
    expect(a.adjusted!).toBeCloseTo(0.3 * 0.6 + 0.4 * 0.4 + 0.3 * 0, 5); // 0.34
    expect(b.adjusted!).toBeCloseTo(0.3 * (2 / 3) + 0.4 * 0.6 + 0.3 * (1 / 9), 5); // ≈0.4733
    expect(b.adjusted!).toBeGreaterThan(a.adjusted!); // 调整值顺序与餐别内一致，与合并相反
    expect(cmp.canConclude).toBe(false); // 甲校晚餐层内缺报 + 边界重叠
    expect(cmp.conclusion).toContain('不强行给出确定的高低结论');
    // 调整结果可展开各层权重、计数与贡献
    const dinner = a.contributions.find((c) => c.mealType === 'dinner')!;
    expect(dinner.weight).toBeCloseTo(0.3, 5);
    expect(dinner.gapFlag).toBe(true);
    expect(dinner.contribution).toBeCloseTo(0, 5);
  });
});

describe('参照缺层与无样本层', () => {
  it('过滤到 9/4-9/5 时甲校晚餐层无可核实资料，不能完成完整调整值', () => {
    const filters: SupplyFilters = { ...DEFAULT_FILTERS, dateFrom: '2026-09-04', dateTo: '2026-09-05' };
    const a = runSupplyAnalysis(dataset, mapping, { ...OPTS, filters });
    const adjA = a.comparison.schools.find((s) => s.schoolId === 'A')!;
    expect(adjA.complete).toBe(false);
    expect(adjA.adjusted).toBeNull();
    expect(adjA.incompleteReasons.join('')).toContain('缺少可核实资料');
    const adjB = a.comparison.schools.find((s) => s.schoolId === 'B')!;
    expect(adjB.complete).toBe(true); // 乙校晚餐资料齐全
    expect(a.comparison.comparableStrata).toEqual(['breakfast', 'lunch']);
    expect(a.comparison.incomparableStrata).toEqual([{ mealType: 'dinner', missingSchools: ['A'] }]);
  });

  it('某层没有样本不能用零比例填补（乙校早餐 9/1-9/2 全部明确停业）', () => {
    const filters: SupplyFilters = { ...DEFAULT_FILTERS, dateFrom: '2026-09-01', dateTo: '2026-09-02' };
    const a = runSupplyAnalysis(dataset, mapping, { ...OPTS, filters });
    const bBreakfast = a.schools.find((s) => s.schoolId === 'B')!.strata.find((s) => s.mealType === 'breakfast')!;
    expect(bBreakfast.actual).toBe(0);
    expect(bBreakfast.closedZero).toBe(2);
    expect(bBreakfast.verifiedRatio).toBeNull(); // 无样本，不是 0%
    const adjB = a.comparison.schools.find((s) => s.schoolId === 'B')!;
    expect(adjB.complete).toBe(false);
    expect(adjB.incompleteReasons.join('')).toContain('不能用零比例填补');
  });
});

describe('补传预览与激活', () => {
  it('补传用料（wul-a-2）：分母不变、未知减少、含有增加，不重复新增供餐记录', () => {
    const preview = previewLateBatch(dataset, mapping, OPTS, 'wul-a-2');
    expect(preview.denominatorBefore).toBe(37);
    expect(preview.denominatorAfter).toBe(37); // 记录早已存在，只改变判断
    expect(preview.unknownBefore - preview.unknownAfter).toBe(2); // 9/4、9/5 晚餐由未知转为可判定
    expect(preview.containsAfter - preview.containsBefore).toBe(1); // 9/4 确认含乳
    expect(preview.transitions.every((t) => t.denominatorEffect === '分母不变')).toBe(true);
    expect(preview.transitions).toHaveLength(2);
  });

  it('补传发餐日志（log-a-2）：缺口转为实际供餐，分母增加且总体闭合', () => {
    const preview = previewLateBatch(dataset, mapping, OPTS, 'log-a-2');
    expect(preview.denominatorAfter - preview.denominatorBefore).toBe(5); // 新增分母
    expect(preview.gapsBefore).toBe(5);
    expect(preview.gapsAfter).toBe(0);
    expect(preview.transitions.every((t) => t.denominatorEffect === '新增分母')).toBe(true);
    // 新记录无用料（wul-a-3 未激活）→ 全部未知，不默认不含
    expect(preview.unknownAfter - preview.unknownBefore).toBe(5);
  });

  it('补传后参照缺层消除、可比范围扩大（9/4-9/5 过滤范围）', () => {
    const filters: SupplyFilters = { ...DEFAULT_FILTERS, dateFrom: '2026-09-04', dateTo: '2026-09-05' };
    const preview = previewLateBatch(dataset, mapping, { ...OPTS, filters }, 'wul-a-2');
    expect(preview.comparableBefore).toEqual(['breakfast', 'lunch']);
    expect(preview.comparableAfter).toEqual(['breakfast', 'lunch', 'dinner']);
    const beforeA = preview.adjustedBefore.find((s) => s.schoolId === 'A')!;
    const afterA = preview.adjustedAfter.find((s) => s.schoolId === 'A')!;
    expect(beforeA.adjusted).toBeNull();
    expect(afterA.adjusted).not.toBeNull();
  });

  it('全部补传激活后：甲校总体闭合、边界可给、调整结论成立', () => {
    const all = runSupplyAnalysis(dataset, mapping, {
      ...OPTS,
      activatedLateBatches: ['wul-a-2', 'log-a-2', 'wul-a-3'],
    });
    const a = all.schools.find((s) => s.schoolId === 'A')!;
    expect(a.reconciliation.complete).toBe(true);
    expect(a.reconciliation.actual).toBe(25);
    expect(a.totals).toMatchObject({ verified: 24, contains: 11, unknown: 1 });
    expect(a.bounds!.lower).toBeCloseTo(11 / 25, 5);
    expect(a.bounds!.upper).toBeCloseTo(12 / 25, 5);
    // 高比例缺报窗口（W2 晚餐 2/5 含有）进入后，甲校晚餐层不再为 0
    const dinner = a.strata.find((s) => s.mealType === 'dinner')!;
    expect(dinner.contains).toBe(3);
    // 调整边界不再重叠：乙校高于甲校
    expect(all.comparison.canConclude).toBe(true);
    expect(all.comparison.conclusion).toContain('乙校');
  });
});

describe('运行不可变与重算一致', () => {
  it('相同资料完整重算结果一致（无局部更新残留旧分母）', () => {
    const again = runSupplyAnalysis(dataset, mapping, OPTS);
    expect(again.schools).toEqual(analysis.schools);
    expect(again.comparison).toEqual(analysis.comparison);
    expect(again.records.map((r) => [r.key, r.status, r.judgment?.verdict])).toEqual(
      analysis.records.map((r) => [r.key, r.status, r.judgment?.verdict]),
    );
  });

  it('历史运行快照不受后续补传影响', () => {
    // analysis 为补传前计算；激活全部补传后重新计算，旧结果保持不变
    runSupplyAnalysis(dataset, mapping, { ...OPTS, activatedLateBatches: ['wul-a-2', 'log-a-2', 'wul-a-3'] });
    expect(schoolA.reconciliation.gaps).toBe(5);
    expect(schoolA.bounds).toBeNull();
    expect(analysis.comparison.schools.find((s) => s.schoolId === 'A')!.adjusted!).toBeCloseTo(0.34, 5);
  });

  it('每种成分各自按供餐记录计算，不把各成分命中数相加当总餐数', () => {
    const egg = runSupplyAnalysis(dataset, mapping, { ...OPTS, allergen: '蛋' });
    const milk = runSupplyAnalysis(dataset, mapping, { ...OPTS, allergen: '乳' });
    // 同一批供餐记录，分母一致；不同成分分子各自独立
    expect(egg.schools[0].totals.actual).toBe(milk.schools[0].totals.actual);
    const eggContains = egg.schools.reduce((acc, s) => acc + s.totals.contains, 0);
    const milkContains = milk.schools.reduce((acc, s) => acc + s.totals.contains, 0);
    expect(eggContains).toBeGreaterThan(0);
    expect(milkContains).toBeGreaterThan(0);
    expect(eggContains + milkContains).not.toBe(egg.schools[0].totals.actual);
  });
});

describe('比较方案与参照稳定性', () => {
  it('参照构成固定，切换学校不改变；餐别筛选时按范围显式归一化', () => {
    const onlyA = runSupplyAnalysis(dataset, mapping, { ...OPTS, filters: { ...DEFAULT_FILTERS, schools: ['A'] } });
    expect(onlyA.comparison.scheme.weights).toEqual(DEFAULT_COMPARISON_SCHEME.weights);
    const noDinner = runSupplyAnalysis(dataset, mapping, {
      ...OPTS,
      filters: { ...DEFAULT_FILTERS, mealTypes: ['breakfast', 'lunch'] },
    });
    expect(noDinner.comparison.scheme.weights).toEqual(DEFAULT_COMPARISON_SCHEME.weights); // 参照本身不变
    expect(noDinner.comparison.effectiveWeights.breakfast).toBeCloseTo(0.3 / 0.7, 5); // 按范围显式归一化
    expect(noDinner.comparison.effectiveWeights.lunch).toBeCloseTo(0.4 / 0.7, 5);
  });

  it('两校比较不各自删层重新归一化：缺层学校调整值为空而非伪同口径', () => {
    const filters: SupplyFilters = { ...DEFAULT_FILTERS, dateFrom: '2026-09-04', dateTo: '2026-09-05' };
    const a = runSupplyAnalysis(dataset, mapping, { ...OPTS, filters });
    const adjA = a.comparison.schools.find((s) => s.schoolId === 'A')!;
    expect(adjA.adjusted).toBeNull(); // 不给貌似完整的数值
    expect(a.comparison.effectiveWeights.dinner).toBeCloseTo(0.3, 5); // 参照权重对两校一致
  });
});
