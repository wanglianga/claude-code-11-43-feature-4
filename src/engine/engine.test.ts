import { describe, expect, it } from 'vitest';
import { parseCsv } from '../lib/csv';
import { nameSimilarity, normalizeName } from '../engine/rules';
import { runEngine, diffRuns, previewImpact } from '../engine/runEngine';
import { buildRunExport } from '../lib/export';
import { loadTestDataset } from '../test/loadTestDataset';
import type { MappingDocument } from '../types';

const dataset = await loadTestDataset();
const seed = dataset.seedMapping;
const run = runEngine(dataset, seed, { mappingRevision: 1, runId: 'RUN-TEST-1', createdAt: '2026-09-11T10:00:00.000Z' });

describe('CSV 解析器', () => {
  it('支持引号包裹、转义双引号与换行', () => {
    const { headers, rows } = parseCsv('a,b\n"x,y","q""q"\n"line1\nline2",z', 'b1');
    expect(headers).toEqual(['a', 'b']);
    expect(rows[0].values).toEqual({ a: 'x,y', b: 'q"q' });
    expect(rows[1].values.a).toBe('line1\nline2');
    expect(rows[1].rowId).toBe('b1#L3');
  });
});

describe('名称相似度', () => {
  it('归一化去除括号与空白，短词包含给高分', () => {
    expect(normalizeName('金穗全麦粉（新配方） ')).toBe('金穗全麦粉');
    expect(nameSimilarity('虾', '基围虾')).toBeGreaterThanOrEqual(60);
    expect(nameSimilarity('高筋粉', '小麦面粉')).toBeLessThan(45);
  });
});

describe('质量检查（全部由样例输入计算）', () => {
  it('五类问题数量符合样例预埋的缺陷', () => {
    const c = run.summary.qualityIssueCounts;
    expect(c.DUPLICATE_KEY).toBe(4); // 供应商条码、菜谱联合键、厨房 usage_id、餐次 session_id
    expect(c.MISSING_KEY).toBe(4); // 供应商空主键 + 空餐次领餐 + 餐次引用缺失菜谱 + 领餐引用悬空餐次
    expect(c.UNIT_CONFLICT).toBe(1); // 高筋粉 kg vs L
    expect(c.TIME_UNASSIGNABLE).toBe(2); // supper 非法窗口 + lunch 时间越界
    expect(c.MANY_TO_MANY).toBe(1); // 条码 6901001000017 编码复用
  });

  it('重复键问题可下钻到至少两条原始行', () => {
    const dup = run.qualityIssues.filter((i) => i.type === 'DUPLICATE_KEY');
    expect(dup.every((i) => i.rowIds.length >= 2)).toBe(true);
    const supDup = dup.find((i) => i.batchId === 'sup-a-1');
    expect(supDup?.message).toContain('6901001000017');
  });

  it('字段四态严格区分，不折叠为同一失败数', () => {
    const notProvided = run.fieldChecks.find((f) => f.batchId === 'sup-b-1' && f.field === 'cert_no' && f.status === 'FIELD_NOT_PROVIDED');
    expect(notProvided?.count).toBe(10); // 乙校整个文件没有该列

    const empty = run.fieldChecks.find((f) => f.batchId === 'sup-a-1' && f.field === 'cert_no' && f.status === 'VALUE_EMPTY');
    expect(empty?.count).toBe(3); // 甲校有列但三行留空

    const pending = run.fieldChecks.filter((f) => f.batchId === 'kit-b-2' && f.status === 'BATCH_PENDING');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((f) => f.count === 6)).toBe(true);

    const refNotFound = run.fieldChecks.filter((f) => f.status === 'REF_NOT_FOUND');
    const fields = refNotFound.map((f) => f.field);
    expect(fields).toContain('session_id->meal_sessions'); // SV-019 幽灵餐次
    expect(fields).toContain('recipe_id->recipes'); // R-A-99 不存在
    expect(fields).toContain('studentAnonId->meal_servings'); // S-9999 无领餐
  });
});

describe('精确匹配与候选并行', () => {
  it('已批准别名自动解析到标准原料', () => {
    const flour = run.resolutions.find((r) => r.scope === 'kitchen:B' && r.sourceKey === '面粉');
    expect(flour?.stdId).toBe('SI001');
    expect(['APPROVED_ALIAS', 'EXACT_CODE', 'CONFIRMED']).toContain(flour?.kind);
  });

  it('编码复用的条码即使存在种子映射也不自动生效，降级为待确认候选', () => {
    const reused = run.resolutions.find((r) => r.scope === 'supplier:A' && r.sourceKey === '6901001000017');
    expect(reused?.kind).toBe('CANDIDATE');
    expect(reused?.stdId).toBeNull();
    expect(reused?.candidates[0]?.reasons.join('；')).toContain('编码复用');
  });

  it('人工确认过的桶装酱油按同一标准原料统计', () => {
    const b010 = run.resolutions.find((r) => r.scope === 'supplier:B' && r.sourceKey === 'B-SP-010');
    expect(b010?.kind).toBe('CONFIRMED');
    expect(b010?.stdId).toBe('SI002');
  });

  it('无映射的新简称生成候选或标记无候选，不会被静默当成零过敏原', () => {
    const sesame = run.resolutions.find((r) => r.scope === 'kitchen:A' && r.sourceKey === '芝麻');
    expect(sesame?.kind).toBe('CANDIDATE');
    const mystery = run.resolutions.find((r) => r.scope === 'kitchen:A' && r.sourceKey === '神秘调料');
    expect(mystery?.kind).toBe('UNMATCHED');
  });
});

describe('过敏原暴露覆盖三桶统计', () => {
  it('样例实际算出确认 4 / 候选 1 / 未知 19，总计 24', () => {
    expect(run.summary.coverage).toEqual({
      total: 24,
      confirmed: 4,
      candidatePending: 1,
      unknownMissing: 19,
    });
  });

  it('4 条已确认记录全部命中真实暴露，未把缺失误计为安全', () => {
    expect(run.summary.confirmedExposures).toBe(4);
    expect(run.summary.confirmedSafe).toBe(0);
    const hits = run.assessments.filter((a) => a.exposedConfirmed.length > 0).map((a) => a.servingId);
    expect(hits.sort()).toEqual(['SV-004', 'SV-008', 'SV-009', 'SV-010']);
  });

  it('候选桶中的 SV-006 不计过敏原结论，仅提示待确认', () => {
    const a = run.assessments.find((x) => x.servingId === 'SV-006');
    expect(a?.bucket).toBe('CANDIDATE_PENDING');
    expect(a?.exposedConfirmed).toEqual([]);
  });

  it('未知原因可区分：空餐次、关联不存在、时间无法归属、批次未到齐、计划使用排除', () => {
    const reasons = Object.keys(run.summary.unknownReasonsBreakdown).join('|');
    expect(reasons).toContain('未填写餐次');
    expect(reasons).toContain('不存在');
    expect(reasons).toContain('时间无法归属');
    expect(reasons).toContain('批次尚未到齐');
    expect(reasons).toContain('计划使用');
  });

  it('PLANNED 行不进入任何领餐的实际用料证据', () => {
    const allUsage = run.assessments.flatMap((a) => a.usageRowIds);
    expect(allUsage.some((id) => id.includes('#L11'))).toBe(false); // K-A-11 为 PLANNED
  });

  it('每条评估都带可追溯的计算轨迹', () => {
    expect(run.assessments.every((a) => a.trace.length > 0)).toBe(true);
  });

  it('运行固定引用全部已到齐文件哈希与映射/规则版本', () => {
    const arrived = dataset.manifest.batches.filter((b) => b.status === 'ARRIVED');
    arrived.forEach((b) => expect(run.summary.inputHashes[b.batchId]).toBe(dataset.hashes[b.batchId]));
    expect(run.summary.mappingVersion).toBe(seed.mappingVersion);
    expect(run.summary.ruleVersion).toBe('rules-v1');
  });

  it('指标详情给出分子、分母、排除条件与来源范围', () => {
    const rate = run.metricDetails.find((m) => m.key === 'confirmed_rate')!;
    expect(rate.denominator).toBe(24);
    expect(rate.numerator).toBe(4);
    expect(rate.exclusions.length).toBeGreaterThan(0);
    expect(rate.sourceScope).toContain('meal-2');
  });
});

describe('候选确认后的影响预览与运行对比', () => {
  const confirmedMapping: MappingDocument = structuredClone(seed);
  confirmedMapping.kitchenMappings.push({
    schoolId: 'A',
    kitchenAlias: '芝麻',
    stdId: 'SI010',
    decision: 'CONFIRMED',
    note: '测试中确认候选',
  });

  it('预览显示候选确认只扩大覆盖，不改变未知记录', () => {
    const preview = previewImpact(dataset, seed, confirmedMapping, 1);
    expect(preview.coverageBefore.candidatePending).toBe(1);
    expect(preview.coverageAfter.candidatePending).toBe(0);
    expect(preview.coverageAfter.confirmed).toBe(5);
    expect(preview.coverageAfter.unknownMissing).toBe(19);
    const change = preview.servingBucketChanges.find((c) => c.servingId === 'SV-006');
    expect(change).toEqual({ servingId: 'SV-006', before: 'CANDIDATE_PENDING', after: 'CONFIRMED' });
  });

  it('新运行不静默改写旧运行，diff 给出桶位迁移矩阵', () => {
    const run2 = runEngine(dataset, confirmedMapping, {
      mappingRevision: 2,
      runId: 'RUN-TEST-2',
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect(run.summary.coverage.confirmed).toBe(4); // 旧运行保持不变
    const d = diffRuns(run, run2);
    expect(d.changedServingBuckets.CANDIDATE_PENDING.CONFIRMED).toBe(1);
    expect(d.changedServingBuckets.CONFIRMED.CONFIRMED).toBe(4);
    expect(d.changedServingIds).toEqual(['SV-006']);
  });
});

describe('导出防误读', () => {
  it('导出包含运行编号、口径摘要与完整未知范围及免责声明', () => {
    const ex = buildRunExport(run, '2026-09-11T12:00:00.000Z');
    expect(ex.runId).toBe('RUN-TEST-1');
    expect(ex.unknownScope).toHaveLength(19);
    expect(ex.disclaimer).toContain('不等于');
    expect(ex.caliberSummary.plannedExcluded).toContain('PLANNED');
    expect(ex.inputFileHashes.manifest).toBeTruthy();
  });
});
