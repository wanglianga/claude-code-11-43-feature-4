import type { SupplyAnalysis, SupplyRecordEval } from '../types';
import { mealLabel, schoolLabel } from '../engine/supplyEngine';

export const VERDICT_LABEL: Record<string, string> = {
  CONTAINS: '确认含有',
  NOT_FOUND: '未发现（资料足以排除）',
  UNKNOWN: '无法判定',
};

export const RECORD_STATUS_LABEL: Record<string, string> = {
  ACTUAL: '实际供餐',
  CLOSED: '明确停业',
  ZERO_SERVED: '明确零供餐',
  GAP: '未解释缺口',
};

/** 供餐指标导出载荷：与页面图表引用同一次计算 */
export interface SupplyExport {
  exportKind: 'school-supply-comparability';
  exportedAt: string;
  runId: string;
  allergen: string;
  generatedAt: string;
  filters: SupplyAnalysis['filters'];
  activatedLateBatches: string[];
  inputFileHashes: Record<string, string>;
  mappingVersion: string;
  mappingRevision: number;
  ruleVersion: string;
  scheme: SupplyAnalysis['scheme'];
  effectiveWeights: Record<string, number>;
  reconciliation: Array<{
    schoolId: string;
    school: string;
    expected: number;
    actual: number;
    closedZero: number;
    gaps: number;
    complete: boolean;
  }>;
  strata: Array<{
    schoolId: string;
    school: string;
    mealType: string;
    meal: string;
    actual: number;
    verified: number;
    contains: number;
    notFound: number;
    unknown: number;
    verifiedRatio: number | null;
    lowerBound: number | null;
    upperBound: number | null;
    gaps: number;
  }>;
  totals: Array<{
    schoolId: string;
    school: string;
    actual: number;
    verified: number;
    contains: number;
    unknown: number;
    verifiedRatioMerged: number | null;
    bounds: { lower: number; upper: number } | null;
    boundsBlockedReason: string | null;
  }>;
  comparison: {
    schools: Array<{
      schoolId: string;
      school: string;
      complete: boolean;
      incompleteReasons: string[];
      adjusted: number | null;
      interval: { lower: number; upper: number } | null;
      contributions: Array<{
        mealType: string;
        meal: string;
        weight: number;
        contains: number;
        verified: number;
        actual: number;
        unknown: number;
        gaps: number;
        contribution: number | null;
        gapFlag: boolean;
      }>;
    }>;
    comparableStrata: string[];
    incomparableStrata: Array<{ mealType: string; missingSchools: string[] }>;
    canConclude: boolean;
    conclusion: string;
  };
  /** 留下与舍弃的记录范围：局部可比结果同样列出 */
  recordScope: {
    included: Array<{ key: string; school: string; window: string; date: string; meal: string; verdict: string | null }>;
    excluded: Array<{ key: string; school: string; window: string; date: string; meal: string; status: string; reason: string }>;
  };
  records: SupplyRecordEval[];
  disclaimer: string;
}

export function buildSupplyExport(analysis: SupplyAnalysis, runId: string, exportedAt: string): SupplyExport {
  const included: SupplyExport['recordScope']['included'] = [];
  const excluded: SupplyExport['recordScope']['excluded'] = [];
  analysis.records.forEach((r) => {
    const base = {
      key: r.key,
      school: schoolLabel(r.schoolId),
      window: r.serviceWindow,
      date: r.bizDate,
      meal: mealLabel(r.mealType),
    };
    if (r.status === 'ACTUAL') {
      included.push({ ...base, verdict: r.judgment ? VERDICT_LABEL[r.judgment.verdict] : null });
    } else {
      excluded.push({ ...base, status: RECORD_STATUS_LABEL[r.status], reason: r.inclusionReason });
    }
  });

  return {
    exportKind: 'school-supply-comparability',
    exportedAt,
    runId,
    allergen: analysis.allergen,
    generatedAt: analysis.generatedAt,
    filters: analysis.filters,
    activatedLateBatches: analysis.activatedLateBatches,
    inputFileHashes: analysis.inputHashes,
    mappingVersion: analysis.mappingVersion,
    mappingRevision: analysis.mappingRevision,
    ruleVersion: analysis.ruleVersion,
    scheme: analysis.scheme,
    effectiveWeights: analysis.comparison.effectiveWeights,
    reconciliation: analysis.schools.map((s) => ({
      schoolId: s.schoolId,
      school: schoolLabel(s.schoolId),
      expected: s.reconciliation.expected,
      actual: s.reconciliation.actual,
      closedZero: s.reconciliation.closedZero,
      gaps: s.reconciliation.gaps,
      complete: s.reconciliation.complete,
    })),
    strata: analysis.schools.flatMap((s) =>
      s.strata.map((t) => ({
        schoolId: s.schoolId,
        school: schoolLabel(s.schoolId),
        mealType: t.mealType,
        meal: mealLabel(t.mealType),
        actual: t.actual,
        verified: t.verified,
        contains: t.contains,
        notFound: t.notFound,
        unknown: t.unknown,
        verifiedRatio: t.verifiedRatio,
        lowerBound: t.lowerBound,
        upperBound: t.upperBound,
        gaps: t.gaps,
      })),
    ),
    totals: analysis.schools.map((s) => ({
      schoolId: s.schoolId,
      school: schoolLabel(s.schoolId),
      actual: s.totals.actual,
      verified: s.totals.verified,
      contains: s.totals.contains,
      unknown: s.totals.unknown,
      verifiedRatioMerged: s.verifiedRatioMerged,
      bounds: s.bounds,
      boundsBlockedReason: s.boundsBlockedReason,
    })),
    comparison: {
      schools: analysis.comparison.schools.map((s) => ({
        schoolId: s.schoolId,
        school: schoolLabel(s.schoolId),
        complete: s.complete,
        incompleteReasons: s.incompleteReasons,
        adjusted: s.adjusted,
        interval: s.interval,
        contributions: s.contributions.map((c) => ({
          mealType: c.mealType,
          meal: mealLabel(c.mealType),
          weight: c.weight,
          contains: c.contains,
          verified: c.verified,
          actual: c.actual,
          unknown: c.unknown,
          gaps: c.gaps,
          contribution: c.contribution,
          gapFlag: c.gapFlag,
        })),
      })),
      comparableStrata: analysis.comparison.comparableStrata,
      incomparableStrata: analysis.comparison.incomparableStrata,
      canConclude: analysis.comparison.canConclude,
      conclusion: analysis.comparison.conclusion,
    },
    recordScope: { included, excluded },
    records: analysis.records,
    disclaimer:
      '本文件为数据覆盖与指标口径分析：「无法判定」表示当前来源缺少证据，不等于该餐确认不含该成分；' +
      '比例边界只是未知记录不同取值下的边界，不是置信区间，也不是学生实际暴露率；' +
      '本分析不评价哪所学校更安全，也不根据群体记录推断学生实际摄入。',
  };
}

/** 供餐记录明细 CSV：每行一条供餐记录（统计单位），含纳入/去重/判断原因 */
export function supplyRecordsToCsv(analysis: SupplyAnalysis): string {
  const header = [
    'school',
    'service_window',
    'biz_date',
    'meal_type',
    'status',
    'segments',
    'servings',
    'verdict',
    'positive_rows',
    'negative_rows',
    'unknown_rows',
    'planned_excluded',
    'log_rows_raw',
    'duplicates_removed',
    'registry_overlap',
    'inclusion_reason',
    'judgment_reasons',
  ];
  const lines = [header.join(',')];
  analysis.records.forEach((r) => {
    lines.push(
      [
        schoolLabel(r.schoolId),
        r.serviceWindow,
        r.bizDate,
        mealLabel(r.mealType),
        RECORD_STATUS_LABEL[r.status],
        r.segments.map((s) => `${s.start}-${s.end}`).join('+'),
        r.servings ?? '',
        r.judgment ? VERDICT_LABEL[r.judgment.verdict] : '',
        r.judgment?.positiveRows.length ?? '',
        r.judgment?.negativeRows.length ?? '',
        r.judgment?.unknownRows.length ?? '',
        r.judgment?.plannedExcluded ?? '',
        r.dedup.rawLogRows,
        r.dedup.duplicatesRemoved,
        r.dedup.registryOverlap ? '是' : '否',
        r.inclusionReason,
        r.judgment?.reasons.join('；') ?? '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
  });
  return '﻿' + lines.join('\n');
}
