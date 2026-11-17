import type { RawRow } from '../types';

/**
 * 轻量 CSV 解析（RFC4180 子集）：支持引号包裹、引号内逗号/换行、双引号转义。
 * 样例数据均为 UTF-8，不引入额外依赖。
 */
export function parseCsv(text: string, batchId: string): { headers: string[]; rows: RawRow[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRecord();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      pushRecord();
    } else {
      field += ch;
    }
  }
  // 最后一行（无结尾换行）
  if (field.length > 0 || record.length > 0) pushRecord();

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const rows: RawRow[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = (nonEmpty[i][idx] ?? '').trim();
    });
    rows.push({ rowId: `${batchId}#L${i + 1}`, batchId, lineNo: i + 1, values });
  }
  return { headers, rows };
}
