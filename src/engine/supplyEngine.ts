import type {
  AdjustedResult,
  ComparisonResult,
  ComparisonScheme,
  ComponentJudgment,
  DeclaredScope,
  LateBatchPreview,
  MappingDocument,
  RawRow,
  SchoolIndicator,
  StandardIngredient,
  StratumContribution,
  StratumStats,
  SupplyAnalysis,
  SupplyFilters,
  SupplyRecordEval,
  SupplyRecordStatus,
  UsageEvidenceRow,
} from '../types';
import type { Dataset } from '../lib/loadDataset';
import { buildContext } from './context';
import { buildKitchenResolutions, kitchenResolverStorage } from './matching';
import { RULE_VERSION } from './rules';

export const MEAL_TYPE_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
};

export const MEAL_TYPE_ORDER = ['breakfast', 'lunch', 'dinner'];

export const SCHOOL_LABEL: Record<string, string> = { A: '甲校', B: '乙校' };

export function schoolLabel(schoolId: string): string {
  return SCHOOL_LABEL[schoolId] ?? `${schoolId} 校`;
}

export function mealLabel(mealType: string): string {
  return MEAL_TYPE_LABEL[mealType] ?? mealType;
}

function fmtPctText(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** 固定参照餐别结构：比较方案维护参照构成，切换学校不随之改变 */
export const DEFAULT_COMPARISON_SCHEME: ComparisonScheme = {
  schemeId: 'ref-std-2026',
  schemeVersion: 'v1',
  name: '共同参照餐别结构（2026 学年标准供餐结构）',
  weights: { breakfast: 0.3, lunch: 0.4, dinner: 0.3 },
  exclusionNote:
    '明确停业/零供餐不计入实际供餐分母；未解释缺口存在时不套用完整比例公式；无样本层不以零比例填补；菜品行、原料行与发餐份数均不作分母。',
  note: '参照构成固定保存在比较方案中，切换学校或查看历史运行时不随之改变；仅在比较范围（餐别筛选）变化时按范围显式归一化并展示。',
};

export const DEFAULT_FILTERS: SupplyFilters = {
  schools: ['A', 'B'],
  mealTypes: [...MEAL_TYPE_ORDER],
  dateFrom: '2026-09-01',
  dateTo: '2026-09-05',
};

export function recordKey(schoolId: string, serviceWindow: string, bizDate: string, mealType: string): string {
  return `${schoolId}|${serviceWindow}|${bizDate}|${mealType}`;
}

/** 枚举日期区间（含端点），输入 YYYY-MM-DD */
export function enumDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return out;
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** 来源声明的完成范围是否覆盖指定 学校/窗口/餐别/日期 */
export function scopeCovers(
  scopes: DeclaredScope[] | undefined,
  schoolId: string,
  serviceWindow: string,
  mealType: string,
  bizDate: string,
): boolean {
  if (!scopes) return false;
  return scopes.some((s) => {
    const schoolOk = s.schoolId === '*' || s.schoolId === schoolId;
    const windowOk = s.serviceWindow === '*' || s.serviceWindow === serviceWindow;
    const mealOk = s.mealTypes === '*' || s.mealTypes.includes(mealType);
    const dateOk = bizDate >= s.dateFrom && bizDate <= s.dateTo;
    return schoolOk && windowOk && mealOk && dateOk;
  });
}

interface EffectiveBatches {
  logRows: RawRow[];
  usageRows: RawRow[];
  registryRows: RawRow[];
  closureRows: RawRow[];
  inputHashes: Record<string, string>;
  activatedUsed: string[];
}

/** 汇总有效输入：已到账批次 + 本次激活的补传批次 */
function collectEffective(dataset: Dataset, activatedLateBatches: string[]): EffectiveBatches {
  const activated = dataset.pendingBatches.filter((b) => activatedLateBatches.includes(b.meta.batchId));
  const effective = [...dataset.loadedBatches, ...activated];
  const inputHashes: Record<string, string> = {};
  effective.forEach((b) => {
    inputHashes[b.meta.batchId] = b.fileHash;
  });
  inputHashes.manifest = dataset.metaHashes.manifest;

  const logRows: RawRow[] = [];
  const usageRows: RawRow[] = [];
  const registryRows: RawRow[] = [];
  const closureRows: RawRow[] = [];
  effective.forEach((b) => {
    if (b.meta.sourceType === 'service_log') logRows.push(...b.rows);
    else if (b.meta.sourceType === 'window_usage') usageRows.push(...b.rows);
    else if (b.meta.sourceType === 'window_registry') registryRows.push(...b.rows);
    else if (b.meta.sourceType === 'closure_evidence') closureRows.push(...b.rows);
  });
  return {
    logRows,
    usageRows,
    registryRows,
    closureRows,
    inputHashes,
    activatedUsed: activated.map((b) => b.meta.batchId),
  };
}

function declaredScopesFor(dataset: Dataset, sourceType: string, activatedUsed: string[]): DeclaredScope[] {
  const scopes: DeclaredScope[] = [];
  dataset.manifest.batches.forEach((b) => {
    if (b.sourceType !== sourceType) return;
    if (b.status === 'PENDING' && !activatedUsed.includes(b.batchId)) return;
    (b.declaredScope ?? []).forEach((s) => scopes.push(s));
  });
  return scopes;
}

export interface BuildRecordsResult {
  records: SupplyRecordEval[];
  /** 日志行指向登记范围之外的组合（样例中应为 0，保留以便核查） */
  outOfScopeLogRowIds: string[];
}

/**
 * 供餐记录构建与总体核对：
 * - 统计单位 = 学校+窗口+业务日+餐别；同一窗口同餐别多段开放时间合并为同一记录
 * - 重复上报（同 log_id）与登记表重叠（多对多连接）不复制供餐记录
 * - 计划开餐行不证明实际供餐；明确停业/零供餐不计入实际供餐分母；无日志且无停业依据保留为未解释缺口
 */
export function buildSupplyRecords(
  dataset: Dataset,
  filters: SupplyFilters,
  activatedLateBatches: string[],
): BuildRecordsResult {
  const eff = collectEffective(dataset, activatedLateBatches);
  const logScopes = declaredScopesFor(dataset, 'service_log', eff.activatedUsed);
  const dates = enumDates(filters.dateFrom, filters.dateTo);

  // 1. 应覆盖集合：登记表展开为 窗口×餐别×日期，重叠登记去重（多对多连接不复制记录）
  const expected = new Map<string, { registryRowIds: string[]; overlap: boolean }>();
  eff.registryRows.forEach((r) => {
    const school = r.values.school_id;
    const win = r.values.service_window;
    const meal = r.values.meal_type;
    if (!filters.schools.includes(school)) return;
    if (!filters.mealTypes.includes(meal)) return;
    const from = r.values.period_from > filters.dateFrom ? r.values.period_from : filters.dateFrom;
    const to = r.values.period_to < filters.dateTo ? r.values.period_to : filters.dateTo;
    enumDates(from, to).forEach((d) => {
      if (!dates.includes(d)) return;
      const key = recordKey(school, win, d, meal);
      const slot = expected.get(key) ?? { registryRowIds: [], overlap: false };
      if (slot.registryRowIds.length > 0) slot.overlap = true;
      slot.registryRowIds.push(r.rowId);
      expected.set(key, slot);
    });
  });

  // 2. 发餐日志分组：ACTUAL 行按记录键聚合，同 log_id 去重；PLANNED 行单独保留
  const actualLogByKey = new Map<string, RawRow[]>();
  const plannedLogByKey = new Map<string, RawRow[]>();
  const outOfScopeLogRowIds: string[] = [];
  eff.logRows.forEach((r) => {
    const school = r.values.school_id;
    const win = r.values.service_window;
    const date = r.values.biz_date;
    const meal = r.values.meal_type;
    const key = recordKey(school, win, date, meal);
    if (r.values.entry_kind === 'PLANNED') {
      const list = plannedLogByKey.get(key) ?? [];
      list.push(r);
      plannedLogByKey.set(key, list);
      return;
    }
    const list = actualLogByKey.get(key) ?? [];
    list.push(r);
    actualLogByKey.set(key, list);
  });

  // 3. 停业/零供餐依据
  const closureByKey = new Map<string, RawRow[]>();
  eff.closureRows.forEach((r) => {
    const key = recordKey(r.values.school_id, r.values.service_window, r.values.biz_date, r.values.meal_type);
    const list = closureByKey.get(key) ?? [];
    list.push(r);
    closureByKey.set(key, list);
  });

  const records: SupplyRecordEval[] = [];

  expected.forEach((slot, key) => {
    const [schoolId, serviceWindow, bizDate, mealType] = key.split('|');
    const rawLogRows = actualLogByKey.get(key) ?? [];
    // 同 log_id 视为重复上报，只保留一行
    const seenLogIds = new Set<string>();
    const distinctRows: RawRow[] = [];
    rawLogRows.forEach((r) => {
      const id = r.values.log_id;
      if (id && seenLogIds.has(id)) return;
      if (id) seenLogIds.add(id);
      distinctRows.push(r);
    });
    const duplicatesRemoved = rawLogRows.length - distinctRows.length;
    const plannedRows = plannedLogByKey.get(key) ?? [];
    const closures = closureByKey.get(key) ?? [];
    const closureType = closures[0]?.values.closure_type;

    const base = {
      key,
      schoolId,
      serviceWindow,
      bizDate,
      mealType,
      plannedLogRowIds: plannedRows.map((r) => r.rowId),
      closureRowIds: closures.map((r) => r.rowId),
      registryRowIds: slot.registryRowIds,
    };

    if (distinctRows.length > 0) {
      const segments = distinctRows.map((r) => ({ start: r.values.segment_start, end: r.values.segment_end }));
      const servings = distinctRows.reduce((acc, r) => {
        const n = Number(r.values.servings_count);
        return Number.isFinite(n) && r.values.servings_count !== '' ? acc + n : acc;
      }, 0);
      records.push({
        ...base,
        status: 'ACTUAL',
        segments,
        servings,
        logRowIds: distinctRows.map((r) => r.rowId),
        dedup: { rawLogRows: rawLogRows.length, duplicatesRemoved, registryOverlap: slot.overlap },
        inclusionReason:
          `有实际发餐日志 ${rawLogRows.length} 行` +
          (duplicatesRemoved > 0 ? `，去重 ${duplicatesRemoved} 行重复上报` : '') +
          (segments.length > 1 ? `，${segments.length} 段开放时间合并为同一供餐记录` : '') +
          (slot.overlap ? '；登记表存在重叠调整单，已按记录键去重' : '') +
          '，纳入实际供餐分母',
        judgment: null,
      });
      return;
    }

    if (closures.length > 0) {
      const status: SupplyRecordStatus = closureType === 'ZERO_SERVED' ? 'ZERO_SERVED' : 'CLOSED';
      records.push({
        ...base,
        status,
        segments: [],
        servings: null,
        logRowIds: [],
        dedup: { rawLogRows: 0, duplicatesRemoved: 0, registryOverlap: slot.overlap },
        inclusionReason:
          (status === 'ZERO_SERVED' ? '明确零供餐（有依据）' : '明确停业（有依据）') +
          `：${closures[0]?.values.evidence_note ?? ''}，不计入实际供餐分母`,
        judgment: null,
      });
      return;
    }

    // 未解释缺口：无实际日志、无停业依据；计划开餐行不能证明发生过供餐
    const declared = scopeCovers(logScopes, schoolId, serviceWindow, mealType, bizDate);
    records.push({
      ...base,
      status: 'GAP',
      segments: [],
      servings: null,
      logRowIds: [],
      dedup: { rawLogRows: 0, duplicatesRemoved: 0, registryOverlap: slot.overlap },
      inclusionReason:
        (plannedRows.length > 0
          ? `仅有计划开餐行 ${plannedRows.length} 条，计划开餐表不能证明发生过供餐；`
          : '无发餐日志；') +
        '也无明确停业/零供餐依据 → 未解释缺口，总体尚不完整' +
        (declared ? '（发餐来源声明覆盖该范围但未上报，属缺报）' : '（无发餐来源声明覆盖该范围）'),
      judgment: null,
    });
  });

  // 日志指向登记范围之外的组合：保留行号以便核查，不生成供餐记录
  actualLogByKey.forEach((rows, key) => {
    if (!expected.has(key)) rows.forEach((r) => outOfScopeLogRowIds.push(r.rowId));
  });

  records.sort((a, b) => a.key.localeCompare(b.key));
  return { records, outOfScopeLogRowIds };
}

/**
 * 成分判断（复用主服务已有的厨房简称解析结果作为输入）：
 * - 有一条充分含有依据即可确认存在该成分，其他原料缺失不清空该依据
 * - 只有完整到足以排除该成分的资料才可归入未发现；缺报不默认不含
 */
export function judgeRecord(
  record: SupplyRecordEval,
  usageRows: RawRow[],
  standards: Map<string, StandardIngredient>,
  allergen: string,
  usageDeclared: boolean,
): ComponentJudgment {
  const positiveRows: UsageEvidenceRow[] = [];
  const negativeRows: UsageEvidenceRow[] = [];
  const unknownRows: UsageEvidenceRow[] = [];
  const actualRows = usageRows.filter((r) => r.values.status !== 'PLANNED');
  const plannedExcluded = usageRows.length - actualRows.length;

  actualRows.forEach((r) => {
    const alias = r.values.kitchen_alias;
    if (!alias) {
      unknownRows.push({ rowId: r.rowId, alias: '(空)', stdId: null, stdName: null, reason: '原料名称为空' });
      return;
    }
    const resolved = kitchenResolverStorage.resolver.get(`${record.schoolId}|${alias}`);
    if (!resolved || resolved.stdId === null) {
      unknownRows.push({
        rowId: r.rowId,
        alias,
        stdId: null,
        stdName: null,
        reason: resolved?.kind === 'CANDIDATE' ? '存在候选但尚未确认' : '无候选，来源缺失无法判定',
      });
      return;
    }
    const std = standards.get(resolved.stdId);
    if (!std) {
      unknownRows.push({ rowId: r.rowId, alias, stdId: resolved.stdId, stdName: null, reason: '标准原料不存在于参考库' });
      return;
    }
    if (std.allergens.includes(allergen)) {
      positiveRows.push({ rowId: r.rowId, alias, stdId: std.stdId, stdName: std.name, reason: '实际用料含该成分' });
    } else {
      negativeRows.push({ rowId: r.rowId, alias, stdId: std.stdId, stdName: std.name, reason: '已解析且不含该成分' });
    }
  });

  const reasons: string[] = [];
  let verdict: ComponentJudgment['verdict'];
  if (positiveRows.length > 0) {
    verdict = 'CONTAINS';
    reasons.push(`${positiveRows.length} 行实际用料含「${allergen}」，已确认存在该成分`);
    if (unknownRows.length > 0) {
      reasons.push(`另有 ${unknownRows.length} 行原料无法解析；已有一条充分含有依据，不因其他原料缺失清空该判断`);
    }
  } else if (actualRows.length === 0) {
    verdict = 'UNKNOWN';
    reasons.push(
      '有实际发餐但无实际用料记录（用料缺失），缺报不能默认不含 → 无法判定' +
        (usageDeclared ? '；用料来源声明覆盖该范围但未提供数据' : '；无用料来源声明覆盖该范围'),
    );
  } else if (unknownRows.length > 0) {
    verdict = 'UNKNOWN';
    reasons.push(
      `${unknownRows.length} 行原料无法解析（${unknownRows.map((u) => u.alias).join('、')}），` +
        '资料不足以排除该成分；只有完整到足以排除的资料才可归入未发现',
    );
  } else {
    verdict = 'NOT_FOUND';
    reasons.push(`全部 ${negativeRows.length} 行实际用料均已解析且不含「${allergen}」，资料完整到足以排除`);
  }
  if (plannedExcluded > 0) {
    reasons.push(`另有 ${plannedExcluded} 行“计划使用”不计入判断`);
  }

  return { allergen, verdict, positiveRows, negativeRows, unknownRows, plannedExcluded, reasons };
}

/** 餐别分层指标与学校总体核对 */
export function computeSchoolIndicator(
  schoolId: string,
  records: SupplyRecordEval[],
  mealTypes: string[],
): SchoolIndicator {
  const mine = records.filter((r) => r.schoolId === schoolId);
  const strata: StratumStats[] = mealTypes.map((mealType) => {
    const rows = mine.filter((r) => r.mealType === mealType);
    const actual = rows.filter((r) => r.status === 'ACTUAL');
    const contains = actual.filter((r) => r.judgment?.verdict === 'CONTAINS').length;
    const notFound = actual.filter((r) => r.judgment?.verdict === 'NOT_FOUND').length;
    const unknown = actual.filter((r) => r.judgment?.verdict === 'UNKNOWN').length;
    const verified = contains + notFound;
    return {
      mealType,
      expected: rows.length,
      actual: actual.length,
      closedZero: rows.filter((r) => r.status === 'CLOSED' || r.status === 'ZERO_SERVED').length,
      gaps: rows.filter((r) => r.status === 'GAP').length,
      verified,
      contains,
      notFound,
      unknown,
      verifiedRatio: verified > 0 ? contains / verified : null,
      lowerBound: actual.length > 0 ? contains / actual.length : null,
      upperBound: actual.length > 0 ? (contains + unknown) / actual.length : null,
    };
  });

  const actual = mine.filter((r) => r.status === 'ACTUAL');
  const gaps = mine.filter((r) => r.status === 'GAP');
  const closedZero = mine.filter((r) => r.status === 'CLOSED' || r.status === 'ZERO_SERVED');
  const contains = actual.filter((r) => r.judgment?.verdict === 'CONTAINS').length;
  const notFound = actual.filter((r) => r.judgment?.verdict === 'NOT_FOUND').length;
  const unknown = actual.filter((r) => r.judgment?.verdict === 'UNKNOWN').length;
  const verified = contains + notFound;
  const complete = gaps.length === 0;

  return {
    schoolId,
    reconciliation: {
      expected: mine.length,
      actual: actual.length,
      closedZero: closedZero.length,
      gaps: gaps.length,
      complete,
      gapKeys: gaps.map((r) => r.key),
      closedZeroKeys: closedZero.map((r) => r.key),
    },
    strata,
    totals: { actual: actual.length, verified, contains, notFound, unknown },
    verifiedRatioMerged: verified > 0 ? contains / verified : null,
    bounds:
      complete && actual.length > 0
        ? { lower: contains / actual.length, upper: (contains + unknown) / actual.length }
        : null,
    boundsBlockedReason: complete
      ? null
      : `总体存在 ${gaps.length} 个未解释缺口（应覆盖但既无发餐记录又无停业依据），不能套用完整公式给出貌似完整的学校比例`,
  };
}

/** 直接标准化比较：共同参照餐别权重，学校按同一种供餐结构计算 */
export function computeComparison(
  indicators: SchoolIndicator[],
  scheme: ComparisonScheme,
  mealTypes: string[],
): ComparisonResult {
  // 参照权重按当前比较范围显式归一化（切换学校不改变参照构成）
  const weightSum = mealTypes.reduce((acc, m) => acc + (scheme.weights[m] ?? 0), 0);
  const effectiveWeights: Record<string, number> = {};
  mealTypes.forEach((m) => {
    effectiveWeights[m] = weightSum > 0 ? (scheme.weights[m] ?? 0) / weightSum : 0;
  });

  const schools: AdjustedResult[] = indicators.map((ind) => {
    const contributions: StratumContribution[] = ind.strata.map((s) => {
      const weight = effectiveWeights[s.mealType] ?? 0;
      return {
        mealType: s.mealType,
        weight,
        verifiedRatio: s.verifiedRatio,
        contains: s.contains,
        verified: s.verified,
        actual: s.actual,
        unknown: s.unknown,
        gaps: s.gaps,
        contribution: s.verifiedRatio !== null ? weight * s.verifiedRatio : null,
        gapFlag: s.gaps > 0,
      };
    });

    const incompleteReasons: string[] = [];
    contributions.forEach((c) => {
      if (c.contribution !== null) return;
      const stratum = ind.strata.find((s) => s.mealType === c.mealType)!;
      if (stratum.actual === 0 && stratum.closedZero > 0) {
        incompleteReasons.push(
          `${mealLabel(c.mealType)}层无实际供餐样本（${stratum.closedZero} 个组合明确停业/零供餐），不能用零比例填补`,
        );
      } else if (stratum.actual === 0) {
        incompleteReasons.push(`${mealLabel(c.mealType)}层在该校无实际供餐样本，不能用零比例填补`);
      } else {
        incompleteReasons.push(
          `${mealLabel(c.mealType)}层实际供餐 ${stratum.actual} 条但全部无法判定：参照该层缺少可核实资料，不能完成该校的完整调整值`,
        );
      }
    });

    const complete = incompleteReasons.length === 0;
    const adjusted = complete ? contributions.reduce((acc, c) => acc + (c.contribution ?? 0), 0) : null;

    let interval: AdjustedResult['interval'] = null;
    if (complete) {
      let lower = 0;
      let upper = 0;
      contributions.forEach((c) => {
        const stratum = ind.strata.find((s) => s.mealType === c.mealType)!;
        lower += c.weight * (stratum.actual > 0 ? stratum.contains / stratum.actual : 0);
        upper += c.weight * (stratum.actual > 0 ? (stratum.contains + stratum.unknown) / stratum.actual : 0);
      });
      interval = { lower, upper };
    }

    return { schoolId: ind.schoolId, complete, incompleteReasons, contributions, adjusted, interval };
  });

  const comparableStrata = mealTypes.filter((m) =>
    indicators.every((ind) => (ind.strata.find((s) => s.mealType === m)?.verified ?? 0) > 0),
  );
  const incomparableStrata = mealTypes
    .filter((m) => !comparableStrata.includes(m))
    .map((m) => ({
      mealType: m,
      missingSchools: indicators
        .filter((ind) => (ind.strata.find((s) => s.mealType === m)?.verified ?? 0) === 0)
        .map((ind) => ind.schoolId),
    }));

  // 结论：边界重叠或层内缺报时不强行给出确定的高低结论
  let canConclude = false;
  let conclusion: string;
  const adjustedReady = schools.filter((s) => s.adjusted !== null);
  if (adjustedReady.length < schools.length) {
    const blocked = schools.filter((s) => s.adjusted === null);
    conclusion =
      '无法完成全部学校的完整调整：' +
      blocked.map((s) => `${schoolLabel(s.schoolId)}（${s.incompleteReasons.join('；')}）`).join('；') +
      '。只得到局部可比结果，结论不外推到全校。';
  } else if (schools.length < 2) {
    const s = schools[0];
    conclusion = `当前范围仅 ${schoolLabel(s.schoolId)} 一所学校，调整值 ${fmtPctText(s.adjusted!)} 仅用于与固定参照比较，不构成跨校高低结论。`;
    canConclude = false;
  } else {
    const intervalsOverlap =
      schools.length === 2 &&
      schools[0].interval !== null &&
      schools[1].interval !== null &&
      schools[0].interval!.lower <= schools[1].interval!.upper &&
      schools[1].interval!.lower <= schools[0].interval!.upper;
    const hasGapStrata = schools.some((s) => s.contributions.some((c) => c.gapFlag));
    const ordered = [...schools].sort((a, b) => (b.adjusted ?? 0) - (a.adjusted ?? 0));
    const rankingText = ordered
      .map((s) => `${schoolLabel(s.schoolId)} ${fmtPctText(s.adjusted!)}`)
      .join(' vs ');
    if (intervalsOverlap || hasGapStrata) {
      const why: string[] = [];
      if (intervalsOverlap) why.push('两校调整边界重叠');
      if (hasGapStrata) why.push('存在层内未解释缺报');
      conclusion = `同一参照结构下调整值为 ${rankingText}；但${why.join('且')}，不强行给出确定的高低结论。`;
    } else {
      canConclude = true;
      conclusion = `同一参照结构（${mealTypes.map((m) => `${mealLabel(m)} ${(effectiveWeights[m] * 100).toFixed(0)}%`).join('/')}）下，${schoolLabel(ordered[0].schoolId)}调整值高于${schoolLabel(ordered[1].schoolId)}（${rankingText}）。`;
    }
  }

  return {
    scheme,
    mealTypes,
    effectiveWeights,
    schools,
    comparableStrata,
    incomparableStrata,
    canConclude,
    conclusion,
  };
}

export interface SupplyAnalysisOptions {
  allergen: string;
  filters: SupplyFilters;
  activatedLateBatches: string[];
  scheme?: ComparisonScheme;
  mappingRevision: number;
  generatedAt?: string;
}

/** 一次完整供餐指标计算：总体核对 → 成分判断 → 分层指标 → 可比范围分析 */
export function runSupplyAnalysis(
  dataset: Dataset,
  mapping: MappingDocument,
  opts: SupplyAnalysisOptions,
): SupplyAnalysis {
  const scheme = opts.scheme ?? DEFAULT_COMPARISON_SCHEME;
  // 复用主服务已有的成分判断（厨房简称 → 标准原料解析）作为输入
  const ctx = buildContext(dataset);
  buildKitchenResolutions(ctx, mapping);

  const { records } = buildSupplyRecords(dataset, opts.filters, opts.activatedLateBatches);
  const eff = collectEffective(dataset, opts.activatedLateBatches);
  const usageScopes = declaredScopesFor(dataset, 'window_usage', eff.activatedUsed);

  const usageByKey = new Map<string, RawRow[]>();
  eff.usageRows.forEach((r) => {
    const key = recordKey(r.values.school_id, r.values.service_window, r.values.biz_date, r.values.meal_type);
    const list = usageByKey.get(key) ?? [];
    list.push(r);
    usageByKey.set(key, list);
  });

  const evaluated = records.map((rec) => {
    if (rec.status !== 'ACTUAL') return rec;
    const usageRows = usageByKey.get(rec.key) ?? [];
    const declared = scopeCovers(usageScopes, rec.schoolId, rec.serviceWindow, rec.mealType, rec.bizDate);
    const judgment = judgeRecord(rec, usageRows, ctx.standards, opts.allergen, declared);
    return { ...rec, judgment };
  });

  const schools = opts.filters.schools.map((schoolId) =>
    computeSchoolIndicator(schoolId, evaluated, opts.filters.mealTypes),
  );
  const comparison = computeComparison(schools, scheme, opts.filters.mealTypes);

  return {
    allergen: opts.allergen,
    filters: opts.filters,
    activatedLateBatches: eff.activatedUsed,
    scheme,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    inputHashes: eff.inputHashes,
    mappingVersion: mapping.mappingVersion,
    mappingRevision: opts.mappingRevision,
    ruleVersion: RULE_VERSION,
    records: evaluated,
    schools,
    comparison,
  };
}

/**
 * 补传预览：先展示分母/未知/可比范围差异，再生成新运行。
 * 由未知转成含有只改变已有记录的判断，不重复新增已经存在的供餐记录。
 */
export function previewLateBatch(
  dataset: Dataset,
  mapping: MappingDocument,
  base: SupplyAnalysisOptions,
  candidateBatchId: string,
): LateBatchPreview {
  const before = runSupplyAnalysis(dataset, mapping, base);
  const after = runSupplyAnalysis(dataset, mapping, {
    ...base,
    activatedLateBatches: [...base.activatedLateBatches, candidateBatchId],
  });

  const sum = (a: SupplyAnalysis, pick: (s: SchoolIndicator) => number) =>
    a.schools.reduce((acc, s) => acc + pick(s), 0);

  const beforeByKey = new Map(before.records.map((r) => [r.key, r]));
  const transitions: LateBatchPreview['transitions'] = [];
  after.records.forEach((rec) => {
    const b = beforeByKey.get(rec.key);
    const beforeStatus = b?.status ?? null;
    const beforeVerdict = b?.judgment?.verdict ?? null;
    const afterVerdict = rec.judgment?.verdict ?? null;
    if (beforeStatus === rec.status && beforeVerdict === afterVerdict) return;
    transitions.push({
      key: rec.key,
      label: `${schoolLabel(rec.schoolId)} ${rec.serviceWindow} ${rec.bizDate} ${mealLabel(rec.mealType)}`,
      beforeStatus: beforeStatus ?? rec.status,
      afterStatus: rec.status,
      beforeVerdict,
      afterVerdict,
      denominatorEffect: beforeStatus !== 'ACTUAL' && rec.status === 'ACTUAL' ? '新增分母' : '分母不变',
    });
  });

  return {
    candidateBatchId,
    denominatorBefore: sum(before, (s) => s.totals.actual),
    denominatorAfter: sum(after, (s) => s.totals.actual),
    unknownBefore: sum(before, (s) => s.totals.unknown),
    unknownAfter: sum(after, (s) => s.totals.unknown),
    containsBefore: sum(before, (s) => s.totals.contains),
    containsAfter: sum(after, (s) => s.totals.contains),
    gapsBefore: sum(before, (s) => s.reconciliation.gaps),
    gapsAfter: sum(after, (s) => s.reconciliation.gaps),
    transitions,
    comparableBefore: before.comparison.comparableStrata,
    comparableAfter: after.comparison.comparableStrata,
    adjustedBefore: before.comparison.schools.map((s) => ({ schoolId: s.schoolId, adjusted: s.adjusted })),
    adjustedAfter: after.comparison.schools.map((s) => ({ schoolId: s.schoolId, adjusted: s.adjusted })),
  };
}

/** 下钻辅助：在已到账与补传批次中查找原始行 */
export function findSupplyRow(dataset: Dataset, rowId: string): RawRow | undefined {
  const [batchId] = rowId.split('#');
  const arrived = dataset.rowsByBatch[batchId]?.find((r) => r.rowId === rowId);
  if (arrived) return arrived;
  return dataset.pendingBatches.find((b) => b.meta.batchId === batchId)?.rows.find((r) => r.rowId === rowId);
}

/** 可选成分清单：来自标准原料参考库 */
export function allergenOptions(dataset: Dataset): string[] {
  const set = new Set<string>();
  dataset.standards.forEach((s) => s.allergens.forEach((a) => set.add(a)));
  return Array.from(set);
}
