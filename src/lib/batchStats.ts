import type { AnalysisRun, BatchMeta, CoverageCounts, RawRow } from '../types';
import { SOURCE_SCHEMAS, isSupplySource } from './schema';
import type { Dataset } from './loadDataset';
import { batchSchool } from '../engine/context';

export interface BatchStat {
  meta: BatchMeta;
  inputRows: number;
  validRows: number;
  duplicateRows: number;
  duplicateGroups: number;
  missingKeyRows: number;
  linkedRows: number;
  candidateRows: number;
  unknownRows: number;
  fileHash?: string;
}

/** 首页按来源批次统计：输入行数、有效行数、重复行数、成功关联数及未知数（仅领餐级来源） */
export function computeBatchStats(dataset: Dataset, run: AnalysisRun): BatchStat[] {
  const rowsByBatch = dataset.rowsByBatch;
  const resolutionByKey = new Map(run.resolutions.map((r) => [`${r.scope}|${r.sourceKey}`, r]));
  const assessmentsBySession = new Map(run.assessments.map((a) => [a.sessionId, a]));

  // 供餐指标来源在「供餐指标」页独立核对（去重/总体核对），不进入本表
  return dataset.manifest.batches.filter((meta) => !isSupplySource(meta.sourceType)).map((meta): BatchStat => {
    const rows: RawRow[] = rowsByBatch[meta.batchId] ?? [];
    const schema = SOURCE_SCHEMAS[meta.sourceType];

    // 重复键
    const seen = new Map<string, number>();
    let duplicateRows = 0;
    const dupKeys = new Set<string>();
    rows.forEach((r) => {
      const key = schema.keyFields.map((f) => r.values[f] ?? '').join('|');
      if (schema.keyFields.some((f) => !(r.values[f] ?? '').trim())) return;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) {
        duplicateRows += 1;
        dupKeys.add(key);
      }
    });

    const missingKeyRows = rows.filter((r) =>
      schema.keyFields.some((f) => !(r.values[f] ?? '').trim()),
    ).length;

    let linkedRows = 0;
    let candidateRows = 0;
    let unknownRows = 0;

    if (meta.status === 'PENDING') {
      return {
        meta,
        inputRows: 0,
        validRows: 0,
        duplicateRows: 0,
        duplicateGroups: 0,
        missingKeyRows: 0,
        linkedRows: 0,
        candidateRows: 0,
        unknownRows: meta.expectedRows,
      };
    }

    if (meta.sourceType === 'supplier_items') {
      const school = meta.schoolId;
      rows.forEach((r) => {
        const res = resolutionByKey.get(`supplier:${school}|${r.values.supplier_code}`);
        if (!r.values.supplier_code) unknownRows += 1;
        else if (res?.stdId) linkedRows += 1;
        else if (res?.kind === 'CANDIDATE') candidateRows += 1;
        else unknownRows += 1;
      });
    } else if (meta.sourceType === 'kitchen_usage') {
      const school = meta.schoolId;
      rows.forEach((r) => {
        if (r.values.status === 'PLANNED') return; // 计划使用不计入实际关联统计
        const res = resolutionByKey.get(`kitchen:${school}|${r.values.kitchen_alias}`);
        if (!r.values.kitchen_alias) unknownRows += 1;
        else if (res?.stdId) linkedRows += 1;
        else if (res?.kind === 'CANDIDATE') candidateRows += 1;
        else unknownRows += 1;
      });
    } else if (meta.sourceType === 'recipes') {
      rows.forEach((r) => {
        const res = resolutionByKey.get(`recipe|${r.values.ingredient_name}`);
        if (!r.values.ingredient_name) unknownRows += 1;
        else if (res?.stdId) linkedRows += 1;
        else if (res?.kind === 'CANDIDATE') candidateRows += 1;
        else unknownRows += 1;
      });
    } else if (meta.sourceType === 'meal_sessions') {
      rows.forEach((r) => {
        const a = assessmentsBySession.get(r.values.session_id);
        if (a && a.bucket === 'CONFIRMED') linkedRows += 1;
        else if (a && a.bucket === 'CANDIDATE_PENDING') candidateRows += 1;
        else unknownRows += 1;
      });
    } else if (meta.sourceType === 'meal_servings') {
      rows.forEach((r) => {
        const a = run.assessments.find((x) => x.servingId === r.values.serving_id);
        if (a?.bucket === 'CONFIRMED') linkedRows += 1;
        else if (a?.bucket === 'CANDIDATE_PENDING') candidateRows += 1;
        else unknownRows += 1;
      });
    } else if (meta.sourceType === 'diet_restrictions') {
      const served = new Set(
        dataset.rowsByBatch[Object.keys(dataset.rowsByBatch).find((id) => id.startsWith('meal-2')) ?? '']
          ?.map((r) => r.values.student_anon_id) ?? [],
      );
      rows.forEach((r) => {
        if (!r.values.avoidAllergens) unknownRows += 1;
        else if (served.has(r.values.studentAnonId)) linkedRows += 1;
        else unknownRows += 1;
      });
    }

    return {
      meta,
      inputRows: rows.length,
      validRows: rows.length - duplicateRows - missingKeyRows,
      duplicateRows,
      duplicateGroups: dupKeys.size,
      missingKeyRows,
      linkedRows,
      candidateRows,
      unknownRows,
      fileHash: dataset.hashes[meta.batchId],
    };
  });
}

export function sumCoverage(stats: BatchStat[]): { linked: number; candidate: number; unknown: number } {
  return stats.reduce(
    (acc, s) => ({
      linked: acc.linked + s.linkedRows,
      candidate: acc.candidate + s.candidateRows,
      unknown: acc.unknown + s.unknownRows,
    }),
    { linked: 0, candidate: 0, unknown: 0 },
  );
}

export function findRawRow(dataset: Dataset, rowId: string): RawRow | undefined {
  const [batchId] = rowId.split('#');
  return dataset.rowsByBatch[batchId]?.find((r) => r.rowId === rowId);
}

export function batchRows(dataset: Dataset, batchId: string): RawRow[] {
  return dataset.rowsByBatch[batchId] ?? [];
}

export function schoolOf(dataset: Dataset, batchId: string): string {
  return batchSchool(dataset, batchId);
}

export function emptyCoverage(): CoverageCounts {
  return { total: 0, confirmed: 0, candidatePending: 0, unknownMissing: 0 };
}
