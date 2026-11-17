import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { BATCH_LABEL, FIELD_STATUS_LABEL, SOURCE_SCHEMAS } from '../lib/schema';
import { FieldStatusBadge } from '../components/Badges';
import { Drawer, RawRowView } from '../components/Drawer';
import { shortHash } from '../lib/hash';
import type { FieldCheck, RawRow } from '../types';

export function SourcesPage() {
  const { dataset, currentRun } = useAppState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [row, setRow] = useState<RawRow | null>(null);

  const fieldChecksByBatch = useMemo(() => {
    const map = new Map<string, FieldCheck[]>();
    currentRun?.fieldChecks.forEach((fc) => {
      const list = map.get(fc.batchId) ?? [];
      list.push(fc);
      map.set(fc.batchId, list);
    });
    return map;
  }, [currentRun]);

  if (!dataset || !currentRun) return null;

  const selected = dataset.manifest.batches.find((b) => b.batchId === selectedId) ?? null;
  const selectedBatch = dataset.loadedBatches.find((b) => b.meta.batchId === selectedId) ?? null;
  const selectedRows = selectedId ? dataset.rowsByBatch[selectedId] ?? [] : [];

  return (
    <div>
      <h1 className="page-title">来源批次与字段检查</h1>
      <p className="page-desc">
        查看每个来源批次的行数、字段清单、更新时间与内容哈希。字段问题严格区分四种状态：
        源文件未提供、字段值为空、关联对象不存在、来源批次尚未到齐。
      </p>

      <div className="card">
        <h2>批次清单（{dataset.manifest.batches.length} 个）</h2>
        <table className="data">
          <thead>
            <tr>
              <th>批次</th>
              <th>文件</th>
              <th>数据日期</th>
              <th>更新时间</th>
              <th className="num">行数</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dataset.manifest.batches.map((b) => (
              <tr key={b.batchId}>
                <td>
                  <b>{BATCH_LABEL(b)}</b>
                  <div className="muted mono" style={{ fontSize: 11 }}>{b.batchId} · {b.notes}</div>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{b.fileName}</td>
                <td>{b.dataDate}</td>
                <td>{b.updatedAt ?? <span className="muted">未到齐，无更新时间</span>}</td>
                <td className="num">
                  {b.status === 'PENDING' ? `预期 ${b.expectedRows}` : (dataset.rowsByBatch[b.batchId]?.length ?? 0)}
                </td>
                <td>
                  {b.status === 'PENDING' ? <FieldStatusBadge status="BATCH_PENDING" /> : <span className="badge ok">已到齐</span>}
                </td>
                <td><button className="btn small" onClick={() => setSelectedId(b.batchId)}>打开</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <Drawer
          title={BATCH_LABEL(selected)}
          subtitle={`${selected.batchId} · ${selected.fileName}`}
          onClose={() => { setSelectedId(null); setRow(null); }}
        >
          {selected.status === 'PENDING' ? (
            <div className="banner warn">
              该批次状态为「来源批次尚未到齐」（预期 {selected.expectedRows} 行）。依赖该批次的分析一律计入未知，
              不会被当作零行或零过敏原。到齐后重新运行即可比较覆盖率变化。
            </div>
          ) : (
            <>
              <dl className="kv-list">
                <dt>来源类型</dt><dd>{SOURCE_SCHEMAS[selected.sourceType].label}</dd>
                <dt>实际行数</dt><dd>{selectedRows.length}（清单预期 {selected.expectedRows}）</dd>
                <dt>更新时间</dt><dd>{selected.updatedAt}</dd>
                <dt>文件 SHA-256</dt><dd className="mono">{selectedBatch ? shortHash(selectedBatch.fileHash) : ''}…（完整哈希见运行结果 inputHashes）</dd>
                <dt>字段清单</dt><dd className="mono">{selectedBatch?.headers.join('、')}</dd>
              </dl>

              <h3>字段四态检查</h3>
              {(fieldChecksByBatch.get(selected.batchId) ?? []).length === 0 ? (
                <p className="muted">所有期望字段均存在且无空值、无关联缺失。</p>
              ) : (
                <table className="data">
                  <thead><tr><th>字段</th><th>状态</th><th className="num">行数</th></tr></thead>
                  <tbody>
                    {(fieldChecksByBatch.get(selected.batchId) ?? []).map((fc) => (
                      <tr key={`${fc.field}-${fc.status}`}>
                        <td className="mono">{fc.field}</td>
                        <td><FieldStatusBadge status={fc.status} /></td>
                        <td className="num">{fc.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted" style={{ fontSize: 12 }}>
                说明：乙校供应商文件没有 cert_no 列 → 源文件未提供；甲校部分行 cert_no 留空 → 字段值为空；
                领餐引用不存在的餐次/餐次引用不存在的菜谱 → 关联对象不存在；kit-b-2 → 批次未到齐。
              </p>

              <h3>原始行（点击逐行查看）</h3>
              <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>行</th>
                      {(selectedBatch?.headers ?? []).slice(0, 4).map((h) => <th key={h}>{h}</th>)}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.map((r) => (
                      <tr key={r.rowId}>
                        <td className="mono muted">L{r.lineNo}</td>
                        {(selectedBatch?.headers ?? []).slice(0, 4).map((h) => (
                          <td key={h} className="mono" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.values[h] || <span className="muted">空</span>}
                          </td>
                        ))}
                        <td><button className="btn small" onClick={() => setRow(r)}>详情</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Drawer>
      )}

      {row && (
        <Drawer title={`原始行 ${row.rowId}`} subtitle="该行完整字段值" onClose={() => setRow(null)}>
          <RawRowView batchId={row.batchId} lineNo={row.lineNo} values={row.values} />
          <p className="muted" style={{ fontSize: 12 }}>
            {FIELD_STATUS_LABEL.VALUE_EMPTY}与{FIELD_STATUS_LABEL.FIELD_NOT_PROVIDED}在此可直观区分：列为空显示「（空值）」，缺列则不出现在字段清单中。
          </p>
        </Drawer>
      )}
    </div>
  );
}
