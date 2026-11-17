import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { SupplyRecordDrawer } from '../components/SupplyRecordDrawer';
import {
  IntervalBar,
  RecordStatusBadge,
  StratumStackedBar,
  VerdictBadge,
} from '../components/SupplyViz';
import {
  allergenOptions,
  mealLabel,
  previewLateBatch,
  runSupplyAnalysis,
  schoolLabel,
  MEAL_TYPE_ORDER,
} from '../engine/supplyEngine';
import { buildSupplyExport, supplyRecordsToCsv } from '../lib/supplyExport';
import { downloadCsv, downloadJson } from '../lib/export';
import { isSupplySource, SOURCE_SCHEMAS } from '../lib/schema';
import type { LateBatchPreview, SupplyAnalysis, SupplyRecordEval, SupplyRecordStatus } from '../types';

type RecordFilter = { school?: string; mealType?: string; status?: SupplyRecordStatus };

export function SupplyPage() {
  const {
    dataset,
    currentSupply,
    supplyFilters,
    setSupplyFilters,
    supplyAllergen,
    setSupplyAllergen,
    supplyActivation,
    comparisonScheme,
    supplyRuns,
    saveSupplyRun,
    removeSupplyRun,
    activateLateBatch,
    mappingState,
  } = useAppState();

  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [pick, setPick] = useState<SupplyRecordEval | null>(null);
  const [preview, setPreview] = useState<LateBatchPreview | null>(null);
  const [recordFilter, setRecordFilter] = useState<RecordFilter>({});
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const viewingRun = viewRunId ? supplyRuns.find((r) => r.runId === viewRunId) ?? null : null;
  // 图表与导出引用同一次计算：历史运行快照或当前计算
  const analysis: SupplyAnalysis | null = viewingRun ? viewingRun.analysis : currentSupply;
  const live = !viewingRun;

  const allergens = useMemo(() => (dataset ? allergenOptions(dataset) : []), [dataset]);

  const pendingSupplyBatches = useMemo(() => {
    if (!dataset || !supplyActivation) return [];
    return dataset.manifest.batches.filter(
      (b) => b.status === 'PENDING' && isSupplySource(b.sourceType),
    );
  }, [dataset, supplyActivation]);

  const filteredRecords = useMemo(() => {
    if (!analysis) return [];
    return analysis.records.filter(
      (r) =>
        (!recordFilter.school || r.schoolId === recordFilter.school) &&
        (!recordFilter.mealType || r.mealType === recordFilter.mealType) &&
        (!recordFilter.status || r.status === recordFilter.status),
    );
  }, [analysis, recordFilter]);

  if (!dataset || !analysis || !mappingState || !supplyActivation) return null;

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3000);
  };

  const onPreview = (batchId: string) => {
    setPreview(
      previewLateBatch(
        dataset,
        mappingState.doc,
        {
          allergen: supplyAllergen,
          filters: supplyFilters,
          activatedLateBatches: supplyActivation.activated,
          scheme: comparisonScheme,
          mappingRevision: mappingState.revision,
        },
        batchId,
      ),
    );
  };

  const onConfirmLate = async (batchId: string) => {
    setBusy(true);
    try {
      // 先计算补传后的完整结果（与激活后当前计算一致），再激活并保存为新运行
      const next = runSupplyAnalysis(dataset, mappingState.doc, {
        allergen: supplyAllergen,
        filters: supplyFilters,
        activatedLateBatches: [...supplyActivation.activated, batchId],
        scheme: comparisonScheme,
        mappingRevision: mappingState.revision,
      });
      await activateLateBatch(batchId);
      const run = await saveSupplyRun(`补传 ${batchId} 后生成的新运行`, next);
      setPreview(null);
      flash(`已确认补传 ${batchId} 并生成新运行 ${run.runId}（历史运行保持不变）`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSaveRun = async () => {
    setBusy(true);
    try {
      const run = await saveSupplyRun('手动保存');
      flash(`已保存运行 ${run.runId}（刷新后仍可打开）`);
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () =>
    downloadJson(
      `${viewingRun ? viewingRun.runId : 'supply-current'}-${analysis.allergen}.json`,
      buildSupplyExport(analysis, viewingRun?.runId ?? 'CURRENT', new Date().toISOString()),
    );
  const exportCsv = () =>
    downloadCsv(`${viewingRun ? viewingRun.runId : 'supply-current'}-records.csv`, supplyRecordsToCsv(analysis));

  const toggleSchool = (s: string) => {
    const schools = supplyFilters.schools.includes(s)
      ? supplyFilters.schools.filter((x) => x !== s)
      : [...supplyFilters.schools, s];
    if (schools.length === 0) return;
    setSupplyFilters({ ...supplyFilters, schools });
  };
  const toggleMeal = (m: string) => {
    const mealTypes = supplyFilters.mealTypes.includes(m)
      ? supplyFilters.mealTypes.filter((x) => x !== m)
      : [...supplyFilters.mealTypes, m];
    if (mealTypes.length === 0) return;
    setSupplyFilters({ ...supplyFilters, mealTypes: MEAL_TYPE_ORDER.filter((x) => mealTypes.includes(x)) });
  };

  return (
    <div>
      <h1 className="page-title">供餐指标：总体核对与成分记录比例</h1>
      <p className="page-desc">
        统计单位固定为「学校+窗口+业务日+餐别」定位的一次供餐记录；同一窗口同餐别的多段开放时间属于同一记录。
        菜品行、原料行和发餐份数不作分母。本页为数据覆盖与指标口径分析，不评价哪所学校更安全，
        也不根据群体记录推断学生实际摄入。
      </p>

      {viewingRun && (
        <div className="banner info">
          正在查看历史运行 <b className="mono">{viewingRun.runId}</b>（生成于{' '}
          {new Date(viewingRun.createdAt).toLocaleString('zh-CN')}
          {viewingRun.note ? `，${viewingRun.note}` : ''}）。
          该快照继续解释当时的资料覆盖与参照，不受后续补传影响。
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setViewRunId(null)}>返回当前计算</button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>筛选与成分（变化即整体重算总体、分子、分母、未知边界与参照适用性）</h2>
        <div className="filter-bar">
          <label>
            成分（过敏原）：
            <select
              value={analysis.allergen}
              disabled={!live}
              onChange={(e) => setSupplyAllergen(e.target.value)}
              style={{ marginLeft: 6 }}
            >
              {allergens.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <span>
            学校：
            {['A', 'B'].map((s) => (
              <label key={s} style={{ marginLeft: 8 }}>
                <input
                  type="checkbox"
                  checked={analysis.filters.schools.includes(s)}
                  disabled={!live}
                  onChange={() => toggleSchool(s)}
                />{' '}
                {schoolLabel(s)}
              </label>
            ))}
          </span>
          <span>
            餐别：
            {MEAL_TYPE_ORDER.map((m) => (
              <label key={m} style={{ marginLeft: 8 }}>
                <input
                  type="checkbox"
                  checked={analysis.filters.mealTypes.includes(m)}
                  disabled={!live}
                  onChange={() => toggleMeal(m)}
                />{' '}
                {mealLabel(m)}
              </label>
            ))}
          </span>
          <label>
            日期：
            <input
              type="date"
              value={analysis.filters.dateFrom}
              disabled={!live}
              min="2026-09-01"
              max={analysis.filters.dateTo}
              onChange={(e) => setSupplyFilters({ ...supplyFilters, dateFrom: e.target.value })}
              style={{ marginLeft: 6 }}
            />
            至
            <input
              type="date"
              value={analysis.filters.dateTo}
              disabled={!live}
              min={analysis.filters.dateFrom}
              max="2026-09-05"
              onChange={(e) => setSupplyFilters({ ...supplyFilters, dateTo: e.target.value })}
              style={{ marginLeft: 4 }}
            />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          当前范围：{analysis.filters.schools.map(schoolLabel).join('、')} ·{' '}
          {analysis.filters.mealTypes.map(mealLabel).join('、')} · {analysis.filters.dateFrom} 至{' '}
          {analysis.filters.dateTo} · 补传激活：{analysis.activatedLateBatches.length > 0 ? analysis.activatedLateBatches.join('、') : '无'}
          {' '}· 映射 {analysis.mappingVersion} r{analysis.mappingRevision} · {analysis.ruleVersion}
        </p>
      </div>

      {live && pendingSupplyBatches.length > 0 && (
        <div className="card">
          <h2>补传批次（先展示差异，再生成新运行）</h2>
          <table className="data">
            <thead>
              <tr><th>批次</th><th>声明完成范围</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {pendingSupplyBatches.map((b) => {
                const activated = supplyActivation.activated.includes(b.batchId);
                return (
                  <tr key={b.batchId}>
                    <td>
                      <b>{SOURCE_SCHEMAS[b.sourceType].label} · {b.batchId}</b>
                      <div className="muted" style={{ fontSize: 12 }}>{b.notes}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {(b.declaredScope ?? []).map((s, i) => (
                        <div key={i}>
                          {s.schoolId}/{s.serviceWindow}/{s.mealTypes === '*' ? '全部餐别' : s.mealTypes.map(mealLabel).join('+')}/{s.dateFrom}~{s.dateTo}
                        </div>
                      ))}
                    </td>
                    <td>{activated ? <span className="badge ok">已激活（本次范围）</span> : <span className="badge candidate">未到齐</span>}</td>
                    <td>
                      {!activated && (
                        <button className="btn small" onClick={() => onPreview(b.batchId)}>预览影响</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {preview && (
            <div className="preview-panel">
              <h3>补传 {preview.candidateBatchId} 的影响预览（尚未生效）</h3>
              <div className="grid cols-4" style={{ marginBottom: 12 }}>
                <div className="stat"><div className="label">实际供餐分母</div><div className="value">{preview.denominatorBefore} → {preview.denominatorAfter}</div></div>
                <div className="stat unknown"><div className="label">无法判定</div><div className="value">{preview.unknownBefore} → {preview.unknownAfter}</div></div>
                <div className="stat confirmed"><div className="label">确认含有</div><div className="value">{preview.containsBefore} → {preview.containsAfter}</div></div>
                <div className="stat"><div className="label">未解释缺口</div><div className="value">{preview.gapsBefore} → {preview.gapsAfter}</div></div>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>
                可比餐别层：{preview.comparableBefore.map(mealLabel).join('、') || '无'} →{' '}
                <b>{preview.comparableAfter.map(mealLabel).join('、') || '无'}</b>；
                调整值：{preview.adjustedBefore.map((a) => {
                  const after = preview.adjustedAfter.find((x) => x.schoolId === a.schoolId)!;
                  return `${schoolLabel(a.schoolId)} ${fmtPct(a.adjusted)} → ${fmtPct(after.adjusted)}`;
                }).join('，')}
              </p>
              {preview.transitions.length > 0 && (
                <table className="data" style={{ marginBottom: 10 }}>
                  <thead>
                    <tr><th>供餐记录</th><th>状态变化</th><th>判断变化</th><th>分母影响</th></tr>
                  </thead>
                  <tbody>
                    {preview.transitions.map((t) => (
                      <tr key={t.key}>
                        <td>{t.label}</td>
                        <td>{t.beforeStatus} → {t.afterStatus}</td>
                        <td>{t.beforeVerdict ?? '—'} → {t.afterVerdict ?? '—'}</td>
                        <td>
                          {t.denominatorEffect === '新增分母' ? (
                            <span className="badge candidate">新增分母</span>
                          ) : (
                            <span className="badge neutral">分母不变</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted" style={{ fontSize: 12 }}>
                由未知转成含有只改变已有记录的判断（分母不变），不会既新增分子又重复新增已经存在的供餐记录；
                仅缺口转为实际供餐才新增分母。
              </p>
              <div className="pill-group">
                <button className="btn primary small" disabled={busy} onClick={() => void onConfirmLate(preview.candidateBatchId)}>
                  {busy ? '处理中…' : '确认补传并生成新运行'}
                </button>
                <button className="btn small" onClick={() => setPreview(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>总体核对（应覆盖 vs 实际供餐 vs 明确停业/零供餐 vs 未解释缺口）</h2>
        <div className="grid cols-2">
          {analysis.schools.map((s) => (
            <div key={s.schoolId} className="subcard">
              <h3>
                {schoolLabel(s.schoolId)}{' '}
                {s.reconciliation.complete ? (
                  <span className="badge ok">总体已完整</span>
                ) : (
                  <span className="badge issue">总体尚不完整</span>
                )}
              </h3>
              <div className="grid cols-4" style={{ gap: 8 }}>
                <div className="stat"><div className="label">应覆盖组合</div><div className="value">{s.reconciliation.expected}</div></div>
                <div className="stat confirmed"><div className="label">实际供餐（分母）</div><div className="value">{s.reconciliation.actual}</div></div>
                <div className="stat"><div className="label">明确停业/零供餐</div><div className="value">{s.reconciliation.closedZero}</div></div>
                <div className="stat unknown"><div className="label">未解释缺口</div><div className="value">{s.reconciliation.gaps}</div></div>
              </div>
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                实际供餐总量{s.reconciliation.complete ? '已知' : '未知（存在缺口）'}；
                资料完整度（应覆盖中有去向的比例）：
                {s.reconciliation.expected === 0
                  ? '—'
                  : `${(((s.reconciliation.actual + s.reconciliation.closedZero) / s.reconciliation.expected) * 100).toFixed(1)}%`}
                ；未知范围：{s.totals.unknown} 条实际供餐无法判定 + {s.reconciliation.gaps} 个缺口。
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>分层指标（按餐别；点击行下钻该层供餐记录）</h2>
        {analysis.schools.map((s) => (
          <div key={s.schoolId} style={{ marginBottom: 18 }}>
            <h3>{schoolLabel(s.schoolId)}</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>餐别</th>
                  <th className="num">实际供餐</th>
                  <th className="num">已核实</th>
                  <th className="num">确认含有</th>
                  <th className="num">未发现</th>
                  <th className="num">无法判定</th>
                  <th className="num">已核实比例</th>
                  <th>边界（未知取值的上下界）</th>
                  <th className="num">层内缺口</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {s.strata.map((t) => (
                  <tr key={t.mealType}>
                    <td><b>{mealLabel(t.mealType)}</b></td>
                    <td className="num">{t.actual}</td>
                    <td className="num">{t.verified}</td>
                    <td className="num" style={{ color: 'var(--issue)', fontWeight: 700 }}>{t.contains}</td>
                    <td className="num">{t.notFound}</td>
                    <td className="num" style={{ color: 'var(--candidate)', fontWeight: 700 }}>{t.unknown}</td>
                    <td className="num">
                      {t.verifiedRatio === null ? <span className="muted">无样本</span> : fmtPct(t.verifiedRatio)}
                    </td>
                    <td>
                      {t.lowerBound === null || t.upperBound === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <IntervalBar lower={t.lowerBound} upper={t.upperBound} />
                      )}
                    </td>
                    <td className="num">{t.gaps > 0 ? <b style={{ color: 'var(--issue)' }}>{t.gaps}</b> : 0}</td>
                    <td>
                      <button
                        className="btn small"
                        onClick={() => setRecordFilter({ school: s.schoolId, mealType: t.mealType })}
                      >
                        查看记录
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 8 }}>
              <StratumStackedBar
                contains={s.totals.contains}
                notFound={s.totals.notFound}
                unknown={s.totals.unknown}
              />
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              已核实合并比例（只覆盖已核实子集 {s.totals.verified} 条）：<b>{fmtPct(s.verifiedRatioMerged)}</b>；
              {s.bounds ? (
                <>
                  总体已完整，全校比例边界 [{fmtPct(s.bounds.lower)}, {fmtPct(s.bounds.upper)}]
                  （未知记录不同取值下的边界，不是置信区间，也不是学生暴露率）。
                </>
              ) : (
                <span style={{ color: 'var(--issue)' }}>{s.boundsBlockedReason}</span>
              )}
            </p>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>供餐记录明细（{filteredRecords.length} / {analysis.records.length} 条）</h2>
        <div className="filter-bar">
          {recordFilter.school || recordFilter.mealType ? (
            <span className="badge neutral">
              层筛选：{recordFilter.school ? schoolLabel(recordFilter.school) : ''}{' '}
              {recordFilter.mealType ? mealLabel(recordFilter.mealType) : ''}
              <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setRecordFilter({})}>清除</button>
            </span>
          ) : null}
          {(['ALL', 'ACTUAL', 'CLOSED', 'ZERO_SERVED', 'GAP'] as Array<'ALL' | SupplyRecordStatus>).map((st) => (
            <button
              key={st}
              className={`btn small ${recordFilter.status === st || (st === 'ALL' && !recordFilter.status) ? 'primary' : ''}`}
              onClick={() => setRecordFilter({ ...recordFilter, status: st === 'ALL' ? undefined : st })}
            >
              {st === 'ALL' ? '全部' : { ACTUAL: '实际供餐', CLOSED: '明确停业', ZERO_SERVED: '明确零供餐', GAP: '未解释缺口' }[st]}
            </button>
          ))}
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>学校/窗口/日期/餐别</th><th>状态</th><th>判断（{analysis.allergen}）</th>
                <th>开放分段</th><th>去重</th><th>纳入/排除原因</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((r) => (
                <tr key={r.key}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {schoolLabel(r.schoolId)} {r.serviceWindow}
                    <div>{r.bizDate} · {mealLabel(r.mealType)}</div>
                  </td>
                  <td><RecordStatusBadge status={r.status} /></td>
                  <td>{r.judgment ? <VerdictBadge verdict={r.judgment.verdict} /> : <span className="muted">—</span>}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {r.segments.length > 0 ? r.segments.map((s) => `${s.start}-${s.end}`).join(' + ') : '—'}
                  </td>
                  <td className="num">
                    {r.dedup.duplicatesRemoved > 0 || r.dedup.registryOverlap ? (
                      <b style={{ color: 'var(--candidate)' }}>
                        {r.dedup.duplicatesRemoved > 0 ? `-${r.dedup.duplicatesRemoved} 行` : ''}
                        {r.dedup.registryOverlap ? ' 登记重叠' : ''}
                      </b>
                    ) : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 320 }}>{r.inclusionReason}</td>
                  <td><button className="btn small" onClick={() => setPick(r)}>下钻</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>运行与导出（图表与导出引用同一次计算）</h2>
        <div className="pill-group" style={{ marginBottom: 12 }}>
          {live && (
            <button className="btn primary" disabled={busy} onClick={() => void onSaveRun()}>
              保存当前计算为新运行
            </button>
          )}
          <button className="btn" onClick={exportJson}>导出 JSON（含口径与未知范围）</button>
          <button className="btn" onClick={exportCsv}>导出供餐记录明细 CSV</button>
          <Link className="btn" to="/school-compare">前往跨校比较</Link>
        </div>
        {supplyRuns.length > 0 && (
          <table className="data">
            <thead>
              <tr><th>运行编号</th><th>生成时间</th><th>说明</th><th>范围/成分</th><th>补传激活</th><th></th></tr>
            </thead>
            <tbody>
              {supplyRuns.map((r) => (
                <tr key={r.runId} className={viewRunId === r.runId ? 'row-active' : ''}>
                  <td className="mono"><b>{r.runId}</b></td>
                  <td className="nowrap">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                  <td>{r.note ?? '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.analysis.filters.schools.map(schoolLabel).join('、')} · {r.analysis.filters.mealTypes.map(mealLabel).join('、')} · {r.analysis.allergen}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.analysis.activatedLateBatches.join('、') || '无'}</td>
                  <td>
                    <div className="pill-group">
                      <button className="btn small" onClick={() => setViewRunId(r.runId)}>打开</button>
                      <button className="btn small danger" onClick={() => void removeSupplyRun(r.runId)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pick && <SupplyRecordDrawer record={pick} dataset={dataset} onClose={() => setPick(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}
