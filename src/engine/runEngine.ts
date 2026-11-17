import type {
  AnalysisRun,
  CoverageCounts,
  EvidenceBucket,
  FieldCheck,
  MappingDocument,
  MatchResolution,
  MetricDetail,
  QualityIssue,
  RawRow,
  RunSummary,
  ServingAssessment,
  TraceStep,
} from '../types';
import { buildContext } from './context';
import { runFieldChecks, runQualityChecks, qualityIssueCounts } from './quality';
import {
  buildKitchenResolutions,
  buildRecipeResolutions,
  buildSupplierResolutions,
  resolveKitchen,
} from './matching';
import { RULE_VERSION } from './rules';
import type { Dataset } from '../lib/loadDataset';

function inWindow(session: RawRow, ctx: ReturnType<typeof buildContext>): boolean {
  const win = ctx.windows.find(
    (w) =>
      (w.schoolId === '*' || w.schoolId === session.values.school_id) &&
      w.window === session.values.window,
  );
  if (!win) return false;
  const toMin = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const st = toMin(session.values.start_time);
  const et = toMin(session.values.end_time);
  const ws = toMin(win.start);
  const we = toMin(win.end);
  return st !== null && et !== null && ws !== null && we !== null && st >= ws && et <= we;
}

function emptyCoverage(): CoverageCounts {
  return { total: 0, confirmed: 0, candidatePending: 0, unknownMissing: 0 };
}

export interface EngineOptions {
  runId?: string;
  createdAt?: string;
  mappingRevision: number;
}

/** 运行一次完整分析：输入哈希 + 映射版本 + 规则版本固定写入结果 */
export function runEngine(dataset: Dataset, mapping: MappingDocument, opts: EngineOptions): AnalysisRun {
  const ctx = buildContext(dataset);
  const supplierResolutions = buildSupplierResolutions(ctx, mapping);
  const kitchenResolutions = buildKitchenResolutions(ctx, mapping);
  const recipeResolutions = buildRecipeResolutions(ctx);
  const resolutions: MatchResolution[] = [
    ...supplierResolutions,
    ...kitchenResolutions,
    ...recipeResolutions,
  ];

  const qualityIssues = runQualityChecks(ctx);
  const fieldChecks = runFieldChecks(ctx);

  const assessments: ServingAssessment[] = ctx.byType.meal_servings.map((serving) =>
    assessServing(serving, ctx),
  );

  const coverage = emptyCoverage();
  let confirmedExposures = 0;
  let confirmedSafe = 0;
  const unknownReasonsBreakdown: Record<string, number> = {};

  assessments.forEach((a) => {
    coverage.total += 1;
    if (a.bucket === 'CONFIRMED') coverage.confirmed += 1;
    if (a.bucket === 'CANDIDATE_PENDING') coverage.candidatePending += 1;
    if (a.bucket === 'UNKNOWN_MISSING') coverage.unknownMissing += 1;
    if (a.bucket === 'CONFIRMED' && a.exposedConfirmed.length > 0) confirmedExposures += 1;
    if (a.bucket === 'CONFIRMED' && a.exposedConfirmed.length === 0) confirmedSafe += 1;
    a.unknownReasons.forEach((reason) => {
      unknownReasonsBreakdown[reason] = (unknownReasonsBreakdown[reason] ?? 0) + 1;
    });
  });

  const metricDetails = buildMetricDetails(coverage, confirmedExposures, dataset);

  const inputHashes: Record<string, string> = { ...dataset.hashes, ...dataset.metaHashes };
  const summary: RunSummary = {
    runId: opts.runId ?? `RUN-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    inputHashes,
    mappingVersion: mapping.mappingVersion,
    mappingRevision: opts.mappingRevision,
    ruleVersion: RULE_VERSION,
    scopeBatchIds: dataset.manifest.batches.map((b) => b.batchId),
    coverage,
    confirmedExposures,
    confirmedSafe,
    unknownReasonsBreakdown,
    qualityIssueCounts: qualityIssueCounts(qualityIssues),
  };

  return { summary, assessments, qualityIssues, fieldChecks, resolutions, metricDetails };
}

function assessServing(
  serving: RawRow,
  ctx: ReturnType<typeof buildContext>,
): ServingAssessment {
  const trace: TraceStep[] = [];
  const unknownReasons: string[] = [];
  const usageRowIds: string[] = [];
  const allergensConfirmed = new Set<string>();
  let hasCandidateLink = false;
  let hasHardMissing = false;
  let session: RawRow | undefined;
  let schoolId = '';
  let window = '';
  let recipeId = '';

  // 1. 领餐 -> 餐次
  const sid = serving.values.session_id;
  if (!sid) {
    hasHardMissing = true;
    unknownReasons.push('领餐记录未填写餐次');
    trace.push({ stage: 'serving->session', decision: 'UNKNOWN', ref: '(空)' });
  } else {
    session = ctx.sessionById.get(sid);
    if (!session) {
      hasHardMissing = true;
      unknownReasons.push(`餐次 ${sid} 不存在`);
      trace.push({ stage: 'serving->session', decision: 'REF_NOT_FOUND', ref: sid });
    } else {
      schoolId = session.values.school_id;
      window = session.values.window;
      recipeId = session.values.recipe_id;
      trace.push({ stage: 'serving->session', decision: 'OK', ref: sid });
      if (!inWindow(session, ctx)) {
        hasHardMissing = true;
        unknownReasons.push('餐次时间无法归属到约定窗口');
        trace.push({ stage: 'session->window', decision: 'TIME_UNASSIGNABLE', ref: window });
      }
      if (recipeId && !ctx.recipeIds.has(recipeId)) {
        hasHardMissing = true;
        unknownReasons.push(`餐次引用的菜谱 ${recipeId} 不存在`);
      }
    }
  }

  // 2. 餐次/菜谱 -> 厨房实际用料（PLANNED 不计入证据）
  let plannedOnly = 0;
  if (schoolId && recipeId && window && session) {
    const usageDate = session.values.serving_date;
    const usageRows = ctx.usageIndex.get(`${schoolId}|${recipeId}|${window}|${usageDate}`) ?? [];
    const actualRows = usageRows.filter((r) => r.values.status !== 'PLANNED');
    plannedOnly = usageRows.length - actualRows.length;

    if (actualRows.length === 0) {
      const pending = ctx.dataset.manifest.batches.find(
        (b) =>
          b.status === 'PENDING' &&
          b.sourceType === 'kitchen_usage' &&
          (b.schoolId === schoolId || b.schoolId === '*'),
      );
      hasHardMissing = true;
      unknownReasons.push(pending ? '厨房用料批次尚未到齐' : '无厨房实际用料记录（仅计划或缺失）');
    }

    for (const row of actualRows) {
      const alias = row.values.kitchen_alias;
      if (!alias) {
        hasHardMissing = true;
        unknownReasons.push('厨房用料行原料名称为空');
        trace.push({ stage: 'usage->standard', decision: 'VALUE_EMPTY', ref: row.rowId });
        continue;
      }
      const resolved = resolveKitchen(schoolId, alias);
      if (!resolved || resolved.stdId === null) {
        if (resolved?.kind === 'CANDIDATE') {
          hasCandidateLink = true;
          trace.push({ stage: 'usage->standard', decision: 'CANDIDATE', ref: alias });
        } else {
          hasHardMissing = true;
          unknownReasons.push(`厨房简称「${alias}」无候选，来源缺失无法判定`);
          trace.push({ stage: 'usage->standard', decision: 'UNMATCHED', ref: alias });
        }
        continue;
      }
      const std = ctx.standards.get(resolved.stdId);
      if (!std) {
        hasHardMissing = true;
        unknownReasons.push(`标准原料 ${resolved.stdId} 不存在于参考库`);
        continue;
      }
      usageRowIds.push(row.rowId);
      std.allergens.forEach((a) => allergensConfirmed.add(a));
      trace.push({
        stage: 'usage->standard',
        decision: resolved.kind,
        ref: `${alias} -> ${std.stdId}(${std.name})`,
      });
    }
  }

  // 3. 匿名学号 -> 饮食限制（须在领餐当日生效）
  const studentId = serving.values.student_anon_id;
  const diet = ctx.dietByStudent.get(studentId);
  let restrictionAllergens: string[] = [];
  if (!diet) {
    hasHardMissing = true;
    unknownReasons.push('该学生无饮食限制登记，无法判定个体禁忌');
    trace.push({ stage: 'student->diet', decision: 'REF_NOT_FOUND', ref: studentId });
  } else {
    const servedDate = serving.values.served_at.slice(0, 10);
    const from = diet.values.effectiveFrom;
    const to = diet.values.effectiveTo;
    const effective = (!from || servedDate >= from) && (!to || servedDate <= to);
    restrictionAllergens = diet.values.avoidAllergens ? diet.values.avoidAllergens.split(';').filter(Boolean) : [];
    if (!effective) {
      hasHardMissing = true;
      unknownReasons.push('饮食限制在领餐当日尚未生效/已失效');
      trace.push({ stage: 'student->diet', decision: 'NOT_EFFECTIVE', ref: studentId });
    } else if (restrictionAllergens.length === 0) {
      hasHardMissing = true;
      unknownReasons.push('饮食限制登记存在但禁忌过敏原为空');
      trace.push({ stage: 'student->diet', decision: 'VALUE_EMPTY', ref: studentId });
    } else {
      trace.push({ stage: 'student->diet', decision: 'OK', ref: `${studentId}: ${restrictionAllergens.join('/')}` });
    }
  }

  if (plannedOnly > 0) {
    unknownReasons.push(`另有 ${plannedOnly} 条“计划使用”记录，按规则不计入实际暴露证据`);
  }

  const bucket: EvidenceBucket = hasHardMissing
    ? 'UNKNOWN_MISSING'
    : hasCandidateLink
      ? 'CANDIDATE_PENDING'
      : 'CONFIRMED';

  const exposedConfirmed =
    bucket === 'CONFIRMED'
      ? restrictionAllergens.filter((a) => allergensConfirmed.has(a))
      : [];

  return {
    servingId: serving.values.serving_id,
    studentAnonId: studentId,
    sessionId: sid,
    schoolId,
    servedAt: serving.values.served_at,
    window,
    recipeId,
    bucket,
    usageRowIds,
    allergensConfirmed: Array.from(allergensConfirmed).sort(),
    restrictionAllergens,
    exposedConfirmed,
    unknownReasons,
    trace,
  };
}

function buildMetricDetails(
  coverage: CoverageCounts,
  confirmedExposures: number,
  dataset: Dataset,
): MetricDetail[] {
  const arrivedBatches = dataset.manifest.batches.filter((b) => b.status === 'ARRIVED').map((b) => b.batchId);
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  return [
    {
      key: 'confirmed_rate',
      label: '证据确认率',
      numerator: coverage.confirmed,
      denominator: coverage.total,
      exclusions: ['无排除：全部已到齐来源中的领餐记录均进入分母（含未知）'],
      sourceScope: arrivedBatches,
      explanation: `分子=链接链完整且原料经精确编码/批准别名/人工确认解析的领餐；当前 ${pct(coverage.confirmed, coverage.total)}%。未匹配不等于无过敏原。`,
    },
    {
      key: 'candidate_rate',
      label: '候选待确认率',
      numerator: coverage.candidatePending,
      denominator: coverage.total,
      exclusions: ['来源硬缺失的记录不计入本指标，计入未知率'],
      sourceScope: arrivedBatches,
      explanation: '分子=存在名称/规格候选但分析师尚未确认的领餐；确认后才进入正式统计，确认前不低报暴露。',
    },
    {
      key: 'unknown_rate',
      label: '来源缺失未知率',
      numerator: coverage.unknownMissing,
      denominator: coverage.total,
      exclusions: ['区分四种字段态：源文件未提供、值为空、关联不存在、批次未到齐'],
      sourceScope: dataset.manifest.batches.map((b) => b.batchId),
      explanation: '分子=来源缺失或链接链断裂、无法判定的领餐；“暂时没有证据”不能表述为“确认无过敏原”。',
    },
    {
      key: 'exposure_hit_rate',
      label: '已确认记录中的暴露命中率',
      numerator: confirmedExposures,
      denominator: coverage.confirmed,
      exclusions: ['候选待确认与未知记录不参与本指标，避免把缺失误读为安全'],
      sourceScope: arrivedBatches,
      explanation: '分子=已确认领餐中，实际用料过敏原命中该学生禁忌过敏原的记录数。',
    },
  ];
}

// ---------- 运行对比 ----------

export function diffRuns(
  base: AnalysisRun,
  target: AnalysisRun,
): import('../types').RunDiff {
  const matrix: Record<EvidenceBucket, Record<EvidenceBucket, number>> = {
    CONFIRMED: { CONFIRMED: 0, CANDIDATE_PENDING: 0, UNKNOWN_MISSING: 0 },
    CANDIDATE_PENDING: { CONFIRMED: 0, CANDIDATE_PENDING: 0, UNKNOWN_MISSING: 0 },
    UNKNOWN_MISSING: { CONFIRMED: 0, CANDIDATE_PENDING: 0, UNKNOWN_MISSING: 0 },
  };
  const changedServingIds: string[] = [];
  const baseById = new Map(base.assessments.map((a) => [a.servingId, a]));
  const targetById = new Map(target.assessments.map((a) => [a.servingId, a]));

  targetById.forEach((t, id) => {
    const b = baseById.get(id);
    if (!b) {
      matrix.UNKNOWN_MISSING[t.bucket] += 1;
      changedServingIds.push(id);
      return;
    }
    matrix[b.bucket][t.bucket] += 1;
    if (b.bucket !== t.bucket) changedServingIds.push(id);
  });

  const issueKey = (i: QualityIssue) => `${i.type}|${i.batchId}|${i.field}|${i.message}`;
  const baseIssues = new Map(base.qualityIssues.map((i) => [issueKey(i), i]));
  const targetIssues = new Map(target.qualityIssues.map((i) => [issueKey(i), i]));
  const newIssues = target.qualityIssues.filter((i) => !baseIssues.has(issueKey(i)));
  const resolvedIssues = base.qualityIssues.filter((i) => !targetIssues.has(issueKey(i)));

  return {
    baseRunId: base.summary.runId,
    targetRunId: target.summary.runId,
    changedServingBuckets: matrix,
    coverageBefore: base.summary.coverage,
    coverageAfter: target.summary.coverage,
    changedServingIds,
    newIssues,
    resolvedIssues,
  };
}

// ---------- 影响预览（不保存、不生成正式运行） ----------

export interface ImpactPreview {
  changedResolutionKeys: string[];
  servingBucketChanges: Array<{ servingId: string; before: EvidenceBucket; after: EvidenceBucket }>;
  coverageBefore: CoverageCounts;
  coverageAfter: CoverageCounts;
  previewRun: AnalysisRun;
}

export function previewImpact(
  dataset: Dataset,
  baseMapping: MappingDocument,
  draftMapping: MappingDocument,
  baseRevision: number,
): ImpactPreview {
  const before = runEngine(dataset, baseMapping, { mappingRevision: baseRevision, runId: 'PREVIEW-BEFORE' });
  const after = runEngine(dataset, draftMapping, {
    mappingRevision: baseRevision,
    runId: 'PREVIEW-AFTER',
  });

  const changedResolutionKeys: string[] = [];
  const beforeRes = new Map(before.resolutions.map((r) => [`${r.scope}|${r.sourceKey}`, r]));
  after.resolutions.forEach((r) => {
    const b = beforeRes.get(`${r.scope}|${r.sourceKey}`);
    if (!b || b.kind !== r.kind || b.stdId !== r.stdId) {
      changedResolutionKeys.push(`${r.scope}|${r.sourceKey}`);
    }
  });

  const beforeMap = new Map(before.assessments.map((a) => [a.servingId, a]));
  const servingBucketChanges: ImpactPreview['servingBucketChanges'] = [];
  after.assessments.forEach((a) => {
    const b = beforeMap.get(a.servingId);
    if (b && b.bucket !== a.bucket) {
      servingBucketChanges.push({ servingId: a.servingId, before: b.bucket, after: a.bucket });
    }
  });

  return {
    changedResolutionKeys,
    servingBucketChanges,
    coverageBefore: before.summary.coverage,
    coverageAfter: after.summary.coverage,
    previewRun: after,
  };
}

export type { FieldCheck };
