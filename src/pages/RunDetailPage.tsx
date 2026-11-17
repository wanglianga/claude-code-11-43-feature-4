import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { BucketBadge } from '../components/Badges';
import { CoverageDonut } from '../components/Coverage';
import { Drawer, RawRowView } from '../components/Drawer';
import { assessmentsToCsv, buildRunExport, downloadCsv, downloadJson, BUCKET_LABEL } from '../lib/export';
import { findRawRow } from '../lib/batchStats';
import type { EvidenceBucket, ServingAssessment } from '../types';

type Filter = 'ALL' | EvidenceBucket;

export function RunDetailPage() {
  const { runId } = useParams();
  const { runs, dataset, mappingState } = useAppState();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [pick, setPick] = useState<ServingAssessment | null>(null);

  const run = runs.find((r) => r.summary.runId === runId);

  const filtered = useMemo(
    () => (run ? (filter === 'ALL' ? run.assessments : run.assessments.filter((a) => a.bucket === filter)) : []),
    [run, filter],
  );

  if (!run || !dataset || !mappingState) {
    return (
      <div className="card empty">
        未找到运行 {runId}。<Link to="/runs">返回运行列表</Link>
      </div>
    );
  }

  const pickUsageRows = pick
    ? pick.usageRowIds.map((id) => findRawRow(dataset, id)).filter((r): r is NonNullable<typeof r> => Boolean(r))
    : [];

  return (
    <div>
      <h1 className="page-title">
        运行 <span className="mono">{run.summary.runId}</span>
      </h1>
      <p className="page-desc">
        生成于 {new Date(run.summary.createdAt).toLocaleString('zh-CN')}，固定引用映射 {run.summary.mappingVersion}
        （r{run.summary.mappingRevision}）、规则 {run.summary.ruleVersion} 与下方输入文件哈希。
        点击任意领餐记录可逐层打开原始行、映射决定与参与计算的餐次。
      </p>

      <div className="card">
        <h2>运行口径与固定引用</h2>
        <dl className="kv-list">
          <dt>输入文件哈希</dt>
          <dd>
            {Object.entries(run.summary.inputHashes).map(([k, h]) => (
              <div key={k} className="mono" style={{ fontSize: 11 }}>{k}: {h}</div>
            ))}
          </dd>
          <dt>来源范围</dt>
          <dd className="mono">{run.summary.scopeBatchIds.join('、')}</dd>
          <dt>确认暴露 / 确认安全</dt>
          <dd><b style={{ color: 'var(--issue)' }}>{run.summary.confirmedExposures}</b> / {run.summary.confirmedSafe} 条已确认领餐</dd>
          <dt>未知原因分布</dt>
          <dd>
            {Object.entries(run.summary.unknownReasonsBreakdown).map(([reason, n]) => (
              <div key={reason}>{reason}：<b>{n}</b></div>
            ))}
          </dd>
        </dl>
        <div style={{ marginTop: 12 }} className="pill-group">
          <button className="btn small" onClick={() => downloadJson(`${run.summary.runId}.json`, buildRunExport(run, new Date().toISOString()))}>
            导出 JSON（含运行编号/口径摘要/未知范围）
          </button>
          <button className="btn small" onClick={() => downloadCsv(`${run.summary.runId}.csv`, assessmentsToCsv(run))}>
            导出领餐明细 CSV
          </button>
          <Link className="btn small" to="/compare">与其他运行对比</Link>
        </div>
      </div>

      <div className="card">
        <h2>三桶覆盖</h2>
        <CoverageDonut coverage={run.summary.coverage} />
      </div>

      <div className="card">
        <h2>领餐记录评估（{run.assessments.length} 条）</h2>
        <div className="filter-bar">
          {(['ALL', 'CONFIRMED', 'CANDIDATE_PENDING', 'UNKNOWN_MISSING'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`btn small ${filter === f ? 'primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'ALL' ? `全部（${run.assessments.length}）` : `${BUCKET_LABEL[f]}（${run.summary.coverage[f === 'CONFIRMED' ? 'confirmed' : f === 'CANDIDATE_PENDING' ? 'candidatePending' : 'unknownMissing']}）`}
            </button>
          ))}
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>领餐</th><th>匿名学号</th><th>餐次/学校</th><th>证据桶</th>
              <th>实际确认过敏原</th><th>个体禁忌</th><th>命中暴露</th><th>未知原因</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.servingId}>
                <td className="mono">{a.servingId}</td>
                <td className="mono">{a.studentAnonId}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {a.sessionId || <span className="muted">空</span>}
                  <div>{a.schoolId} · {a.window || '—'} · {a.recipeId || '—'}</div>
                </td>
                <td><BucketBadge bucket={a.bucket} /></td>
                <td>{a.allergensConfirmed.join('、') || <span className="muted">—</span>}</td>
                <td>{a.restrictionAllergens.join('、') || <span className="muted">—</span>}</td>
                <td>{a.exposedConfirmed.length > 0 ? <b style={{ color: 'var(--issue)' }}>{a.exposedConfirmed.join('、')}</b> : <span className="muted">—</span>}</td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{a.unknownReasons.join('；') || '—'}</td>
                <td><button className="btn small" onClick={() => setPick(a)}>逐层下钻</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pick && (
        <Drawer
          title={`领餐 ${pick.servingId} 的证据链`}
          subtitle={`${BUCKET_LABEL[pick.bucket]} · 学号 ${pick.studentAnonId}`}
          onClose={() => setPick(null)}
        >
          <dl className="kv-list">
            <dt>领餐时间</dt><dd>{pick.servedAt}</dd>
            <dt>餐次</dt><dd className="mono">{pick.sessionId || '（空）'}（{pick.schoolId || '?'}校 · {pick.window || '?'} · 菜谱 {pick.recipeId || '?'}）</dd>
            <dt>确认过敏原</dt><dd>{pick.allergensConfirmed.join('、') || '无'}</dd>
            <dt>禁忌过敏原</dt><dd>{pick.restrictionAllergens.join('、') || '无登记/为空'}</dd>
            <dt>确认暴露</dt><dd>{pick.exposedConfirmed.length ? <b style={{ color: 'var(--issue)' }}>{pick.exposedConfirmed.join('、')}</b> : '无（仅在证据完整时下此结论）'}</dd>
          </dl>

          <h3>计算轨迹（映射决定逐跳可追溯）</h3>
          <div className="trace">
            {pick.trace.map((t, i) => (
              <div className="step" key={i}><b>{t.stage}</b> → {t.decision} <span className="mono">({t.ref})</span></div>
            ))}
          </div>

          {pick.unknownReasons.length > 0 && (
            <>
              <h3>未知/排除原因</h3>
              <ul>
                {pick.unknownReasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </>
          )}

          <h3>参与计算的厨房实际用料原始行（{pickUsageRows.length}）</h3>
          {pickUsageRows.length === 0 && <p className="muted">无已确认实际用料行（PLANNED 行与未解析简称不计入）。</p>}
          {pickUsageRows.map((r) => {
            const school = dataset.manifest.batches.find((b) => b.batchId === r.batchId)?.schoolId ?? '*';
            const decision = mappingState.doc.kitchenMappings.find(
              (m) => m.schoolId === school && m.kitchenAlias === r.values.kitchen_alias,
            );
            return (
              <div key={r.rowId}>
                <RawRowView batchId={r.batchId} lineNo={r.lineNo} values={r.values} />
                <div className="muted" style={{ fontSize: 12, margin: '-4px 0 10px 8px' }}>
                  映射决定：{decision
                    ? `${decision.decision} → ${decision.stdId}${decision.note ? `（${decision.note}）` : ''}`
                    : '无有效映射（该行未参与过敏原计算）'}
                </div>
              </div>
            );
          })}

          <h3>领餐原始行</h3>
          {(() => {
            const target = dataset.rowsByBatch['meal-2']?.find((r) => r.values.serving_id === pick.servingId);
            return target ? <RawRowView batchId={target.batchId} lineNo={target.lineNo} values={target.values} /> : <span className="muted">未找到</span>;
          })()}
        </Drawer>
      )}
    </div>
  );
}
