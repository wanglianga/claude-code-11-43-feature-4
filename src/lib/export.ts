import type { AnalysisRun, EvidenceBucket } from '../types';

export const BUCKET_LABEL: Record<EvidenceBucket, string> = {
  CONFIRMED: '有证据支持的匹配',
  CANDIDATE_PENDING: '存在候选但需确认',
  UNKNOWN_MISSING: '来源缺失无法判定',
};

/** 导出载荷：运行编号 + 口径摘要 + 未知范围，防止“无证据”被误读为“确认无过敏原” */
export interface RunExport {
  exportKind: 'allergen-coverage-run';
  exportedAt: string;
  runId: string;
  ruleVersion: string;
  mappingVersion: string;
  mappingRevision: number;
  inputFileHashes: Record<string, string>;
  caliberSummary: {
    confirmed: string;
    candidate: string;
    unknown: string;
    plannedExcluded: string;
  };
  coverage: AnalysisRun['summary']['coverage'];
  metricDetails: AnalysisRun['metricDetails'];
  unknownScope: Array<{
    servingId: string;
    studentAnonId: string;
    sessionId: string;
    reasons: string[];
  }>;
  confirmedExposures: Array<{
    servingId: string;
    studentAnonId: string;
    exposedConfirmed: string[];
    usageRowIds: string[];
  }>;
  assessments: AnalysisRun['assessments'];
  qualityIssueCounts: AnalysisRun['summary']['qualityIssueCounts'];
  disclaimer: string;
}

export function buildRunExport(run: AnalysisRun, exportedAt: string): RunExport {
  return {
    exportKind: 'allergen-coverage-run',
    exportedAt,
    runId: run.summary.runId,
    ruleVersion: run.summary.ruleVersion,
    mappingVersion: run.summary.mappingVersion,
    mappingRevision: run.summary.mappingRevision,
    inputFileHashes: run.summary.inputHashes,
    caliberSummary: {
      confirmed:
        '仅精确供应商编码、已批准别名或分析师人工确认的原料解析进入“有证据支持”统计',
      candidate: '名称/规格/单位/成分生成的候选必须经分析师确认后才生效，确认前不计入正式结果',
      unknown:
        '来源缺失、链接断裂、批次未到齐、时间无法归属等一律计入未知，不得表述为“确认无过敏原”',
      plannedExcluded: '厨房 status=PLANNED 的“计划使用”不参与实际暴露计算',
    },
    coverage: run.summary.coverage,
    metricDetails: run.metricDetails,
    unknownScope: run.assessments
      .filter((a) => a.bucket === 'UNKNOWN_MISSING')
      .map((a) => ({
        servingId: a.servingId,
        studentAnonId: a.studentAnonId,
        sessionId: a.sessionId,
        reasons: a.unknownReasons,
      })),
    confirmedExposures: run.assessments
      .filter((a) => a.bucket === 'CONFIRMED' && a.exposedConfirmed.length > 0)
      .map((a) => ({
        servingId: a.servingId,
        studentAnonId: a.studentAnonId,
        exposedConfirmed: a.exposedConfirmed,
        usageRowIds: a.usageRowIds,
      })),
    assessments: run.assessments,
    qualityIssueCounts: run.summary.qualityIssueCounts,
    disclaimer:
      '本文件中的“未知/无法判定”表示当前来源缺少证据，不等于该餐确认不含过敏原；接收方不得据此作出“无过敏原”结论。',
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function assessmentsToCsv(run: AnalysisRun): string {
  const header = [
    'serving_id',
    'student_anon_id',
    'session_id',
    'school_id',
    'served_at',
    'bucket',
    'allergens_confirmed',
    'restriction_allergens',
    'exposed_confirmed',
    'unknown_reasons',
    'usage_row_ids',
  ];
  const lines = [header.join(',')];
  run.assessments.forEach((a) => {
    lines.push(
      [
        a.servingId,
        a.studentAnonId,
        a.sessionId,
        a.schoolId,
        a.servedAt,
        BUCKET_LABEL[a.bucket],
        a.allergensConfirmed.join(';'),
        a.restrictionAllergens.join(';'),
        a.exposedConfirmed.join(';'),
        a.unknownReasons.join(';'),
        a.usageRowIds.join(';'),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
  });
  return '﻿' + lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
