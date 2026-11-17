import type { SupplyRecordEval } from '../types';
import type { Dataset } from '../lib/loadDataset';
import { findSupplyRow } from '../engine/supplyEngine';
import { Drawer, RawRowView } from './Drawer';
import { RecordStatusBadge, VerdictBadge, recordLabel } from './SupplyViz';

/** 供餐记录下钻：每行因何纳入、排除、去重或仍无法判断 */
export function SupplyRecordDrawer({
  record,
  dataset,
  onClose,
}: {
  record: SupplyRecordEval;
  dataset: Dataset;
  onClose: () => void;
}) {
  const j = record.judgment;
  const showRows = (ids: string[]) =>
    ids
      .map((id) => findSupplyRow(dataset, id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));

  return (
    <Drawer title={`供餐记录 ${recordLabel(record)}`} subtitle="统计单位：学校+窗口+业务日+餐别" onClose={onClose}>
      <dl className="kv-list">
        <dt>记录状态</dt>
        <dd><RecordStatusBadge status={record.status} /></dd>
        <dt>纳入/排除原因</dt>
        <dd>{record.inclusionReason}</dd>
        <dt>开放时间分段</dt>
        <dd>{record.segments.length > 0 ? record.segments.map((s) => `${s.start}-${s.end}`).join('、') : '—'}</dd>
        <dt>发餐份数</dt>
        <dd>{record.servings ?? '—'}<span className="muted">（仅作实际供餐证据，不作指标分母）</span></dd>
        <dt>去重信息</dt>
        <dd>
          原始日志 {record.dedup.rawLogRows} 行，去重 {record.dedup.duplicatesRemoved} 行
          {record.dedup.registryOverlap ? '；登记表存在重叠调整单（多对多连接已按记录键去重）' : ''}
        </dd>
        {j && (
          <>
            <dt>成分判断</dt>
            <dd><VerdictBadge verdict={j.verdict} />（成分：{j.allergen}）</dd>
            {j.reasons.map((r) => (
              <div key={r} style={{ display: 'contents' }}>
                <dt></dt>
                <dd className="muted">{r}</dd>
              </div>
            ))}
          </>
        )}
      </dl>

      {j && (
        <>
          <h3>含有依据（{j.positiveRows.length} 行）</h3>
          {j.positiveRows.length === 0 && <p className="muted">无</p>}
          {j.positiveRows.map((u) => (
            <div key={u.rowId} className="candidate-card">
              <b>{u.alias}</b> → {u.stdId}（{u.stdName}） <span className="muted">{u.reason}</span>
            </div>
          ))}
          <h3>已解析且不含该成分（{j.negativeRows.length} 行）</h3>
          {j.negativeRows.length === 0 && <p className="muted">无</p>}
          {j.negativeRows.map((u) => (
            <div key={u.rowId} className="candidate-card">
              <b>{u.alias}</b> → {u.stdId}（{u.stdName}） <span className="muted">{u.reason}</span>
            </div>
          ))}
          <h3>无法解析的用料行（{j.unknownRows.length} 行）</h3>
          {j.unknownRows.length === 0 && <p className="muted">无</p>}
          {j.unknownRows.map((u) => (
            <div key={u.rowId} className="candidate-card">
              <b>{u.alias}</b> <span className="muted">{u.reason}</span>
            </div>
          ))}
        </>
      )}

      {record.logRowIds.length > 0 && (
        <>
          <h3>发餐日志原始行（{record.logRowIds.length}）</h3>
          {showRows(record.logRowIds).map((r) => (
            <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
          ))}
        </>
      )}
      {record.plannedLogRowIds.length > 0 && (
        <>
          <h3>计划开餐行（不证明实际供餐，{record.plannedLogRowIds.length}）</h3>
          {showRows(record.plannedLogRowIds).map((r) => (
            <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
          ))}
        </>
      )}
      {record.closureRowIds.length > 0 && (
        <>
          <h3>停业/零供餐依据原始行（{record.closureRowIds.length}）</h3>
          {showRows(record.closureRowIds).map((r) => (
            <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
          ))}
        </>
      )}
      {j && (j.positiveRows.length + j.negativeRows.length + j.unknownRows.length > 0) && (
        <>
          <h3>窗口用料原始行</h3>
          {showRows([
            ...j.positiveRows.map((u) => u.rowId),
            ...j.negativeRows.map((u) => u.rowId),
            ...j.unknownRows.map((u) => u.rowId),
          ]).map((r) => (
            <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
          ))}
        </>
      )}
      <h3>应覆盖登记原始行（{record.registryRowIds.length}）</h3>
      {showRows(record.registryRowIds).map((r) => (
        <RawRowView key={r.rowId} batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
      ))}
    </Drawer>
  );
}
