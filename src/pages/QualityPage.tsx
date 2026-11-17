import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { FIELD_STATUS_LABEL, SOURCE_SCHEMAS } from '../lib/schema';
import { QUALITY_LABEL } from '../engine/quality';
import { FieldStatusBadge } from '../components/Badges';
import { Drawer, RawRowView } from '../components/Drawer';
import { findRawRow } from '../lib/batchStats';
import type { QualityIssue, QualityIssueType, RawRow } from '../types';

const TYPE_ORDER: QualityIssueType[] = [
  'DUPLICATE_KEY',
  'MISSING_KEY',
  'UNIT_CONFLICT',
  'TIME_UNASSIGNABLE',
  'MANY_TO_MANY',
];

export function QualityPage() {
  const { dataset, currentRun } = useAppState();
  const [typeFilter, setTypeFilter] = useState<QualityIssueType | 'ALL'>('ALL');
  const [issue, setIssue] = useState<QualityIssue | null>(null);

  const issues = useMemo(() => {
    if (!currentRun) return [];
    return typeFilter === 'ALL'
      ? currentRun.qualityIssues
      : currentRun.qualityIssues.filter((i) => i.type === typeFilter);
  }, [currentRun, typeFilter]);

  if (!dataset || !currentRun) return null;

  const issueRows: RawRow[] = [];
  if (issue) {
    issue.rowIds.forEach((id) => {
      const r = findRawRow(dataset, id);
      if (r) issueRows.push(r);
    });
  }

  return (
    <div>
      <h1 className="page-title">数据质量检查</h1>
      <p className="page-desc">
        五类检查全部由输入行计算：重复键、缺失键、单位冲突、时间无法归属、多对多连接。
        每条问题可下钻到参与的原始行；字段级问题单独按四种状态区分，不折叠为同一个失败数。
      </p>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        {TYPE_ORDER.map((t) => (
          <div key={t} className={`stat ${currentRun.summary.qualityIssueCounts[t] > 0 ? 'unknown' : ''}`}>
            <div className="label">{QUALITY_LABEL[t]}</div>
            <div className="value">{currentRun.summary.qualityIssueCounts[t]}</div>
            <div className="hint">条问题</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>问题清单</h2>
        <div className="filter-bar">
          <button className={`btn small ${typeFilter === 'ALL' ? 'primary' : ''}`} onClick={() => setTypeFilter('ALL')}>
            全部（{currentRun.qualityIssues.length}）
          </button>
          {TYPE_ORDER.map((t) => (
            <button
              key={t}
              className={`btn small ${typeFilter === t ? 'primary' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {QUALITY_LABEL[t]}（{currentRun.summary.qualityIssueCounts[t]}）
            </button>
          ))}
        </div>
        <table className="data">
          <thead>
            <tr><th>类型</th><th>批次</th><th>字段</th><th>描述</th><th className="num">涉及行</th><th></th></tr>
          </thead>
          <tbody>
            {issues.map((i, idx) => (
              <tr key={`${i.batchId}-${idx}`}>
                <td><span className="badge issue">{QUALITY_LABEL[i.type]}</span></td>
                <td className="mono">{i.batchId || '（跨批次）'}</td>
                <td className="mono">{i.field}</td>
                <td>{i.message}</td>
                <td className="num">{i.rowIds.length}</td>
                <td>
                  {i.rowIds.length > 0 ? (
                    <button className="btn small" onClick={() => setIssue(i)}>下钻原始行</button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>字段四态分布（不折叠）</h2>
        <table className="data">
          <thead>
            <tr><th>批次</th><th>来源</th><th>字段</th><th>状态</th><th className="num">行数</th></tr>
          </thead>
          <tbody>
            {currentRun.fieldChecks.map((fc, idx) => (
              <tr key={idx}>
                <td className="mono">{fc.batchId}</td>
                <td>{SOURCE_SCHEMAS[dataset.manifest.batches.find((b) => b.batchId === fc.batchId)?.sourceType ?? 'supplier_items'].label}</td>
                <td className="mono">{fc.field}</td>
                <td><FieldStatusBadge status={fc.status} /></td>
                <td className="num">{fc.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {FIELD_STATUS_LABEL.FIELD_NOT_PROVIDED}（如乙校供应商缺 cert_no 列）、
          {FIELD_STATUS_LABEL.VALUE_EMPTY}（甲校部分 cert_no 留空）、
          {FIELD_STATUS_LABEL.REF_NOT_FOUND}（领餐→餐次、餐次→菜谱、限制学生→领餐）、
          {FIELD_STATUS_LABEL.BATCH_PENDING}（kit-b-2 未到齐）分别计数。
        </p>
      </div>

      {issue && (
        <Drawer title={`${QUALITY_LABEL[issue.type]} · ${issue.message}`} subtitle={`字段 ${issue.field} · 批次 ${issue.batchId || '跨批次'}`} onClose={() => setIssue(null)}>
          <p className="muted">以下原始行共同构成该质量问题：</p>
          {issueRows.map((r) => (
            <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
          ))}
        </Drawer>
      )}
    </div>
  );
}
