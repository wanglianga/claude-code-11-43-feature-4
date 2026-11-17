import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { SupplyRecordDrawer } from '../components/SupplyRecordDrawer';
import { IntervalBar, StratumStackedBar } from '../components/SupplyViz';
import { mealLabel, schoolLabel } from '../engine/supplyEngine';
import { buildSupplyExport, supplyRecordsToCsv } from '../lib/supplyExport';
import { downloadCsv, downloadJson } from '../lib/export';
import type { SupplyRecordEval } from '../types';

export function SchoolComparePage() {
  const { dataset, currentSupply } = useAppState();
  const [pick, setPick] = useState<SupplyRecordEval | null>(null);
  const [expandAdjusted, setExpandAdjusted] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  const analysis = currentSupply;

  // 结构说明：各校已核实记录的餐别构成
  const structure = useMemo(() => {
    if (!analysis) return [];
    return analysis.schools.map((s) => ({
      schoolId: s.schoolId,
      shares: s.strata.map((t) => ({
        mealType: t.mealType,
        share: s.totals.verified > 0 ? t.verified / s.totals.verified : 0,
        verified: t.verified,
      })),
    }));
  }, [analysis]);

  if (!dataset || !analysis) return null;
  const cmp = analysis.comparison;
  const twoSchools = analysis.schools.length === 2;

  // 餐别内顺序与合并顺序是否相反（辛普森反转提示）
  const reversal = useMemo(() => {
    if (!twoSchools) return null;
    const [a, b] = analysis.schools;
    if (a.verifiedRatioMerged === null || b.verifiedRatioMerged === null) return null;
    const mergedSign = Math.sign(a.verifiedRatioMerged - b.verifiedRatioMerged);
    if (mergedSign === 0) return null;
    const within = analysis.filters.mealTypes
      .map((m) => {
        const sa = a.strata.find((t) => t.mealType === m)!;
        const sb = b.strata.find((t) => t.mealType === m)!;
        if (sa.verifiedRatio === null || sb.verifiedRatio === null) return null;
        return Math.sign(sa.verifiedRatio - sb.verifiedRatio);
      })
      .filter((x): x is number => x !== null);
    if (within.length === 0) return null;
    const allOpposite = within.every((s) => s === -mergedSign);
    if (!allOpposite) return null;
    return {
      mergedHigher: mergedSign > 0 ? a.schoolId : b.schoolId,
      withinHigher: mergedSign > 0 ? b.schoolId : a.schoolId,
    };
  }, [analysis, twoSchools]);

  const excluded = analysis.records.filter((r) => r.status !== 'ACTUAL');
  const included = analysis.records.filter((r) => r.status === 'ACTUAL');

  const exportJson = () =>
    downloadJson(
      `school-compare-${analysis.allergen}.json`,
      buildSupplyExport(analysis, 'CURRENT', new Date().toISOString()),
    );

  return (
    <div>
      <h1 className="page-title">跨校比较：同一参照结构下的可比性分析</h1>
      <p className="page-desc">
        先列各餐别的原始计数、比例和覆盖，再解释总体构成；调整结果可展开各层实际使用的权重、计数和贡献。
        本页与「供餐指标」页、导出文件引用同一次计算（成分：{analysis.allergen}）。
      </p>

      <div className="card">
        <h2>比较方案（维护餐别分层、参照构成和排除范围）</h2>
        <dl className="kv-list">
          <dt>方案</dt>
          <dd>{cmp.scheme.name} <span className="mono muted">（{cmp.scheme.schemeId} · {cmp.scheme.schemeVersion}）</span></dd>
          <dt>固定参照构成</dt>
          <dd>{Object.entries(cmp.scheme.weights).map(([m, w]) => `${mealLabel(m)} ${(w * 100).toFixed(0)}%`).join(' / ')}</dd>
          <dt>当前比较范围权重</dt>
          <dd>
            {cmp.mealTypes.map((m) => `${mealLabel(m)} ${(cmp.effectiveWeights[m] * 100).toFixed(1)}%`).join(' / ')}
            {JSON.stringify(cmp.effectiveWeights) !== JSON.stringify(cmp.scheme.weights) && (
              <span className="muted">（按比较范围显式归一化；参照构成本身未改变）</span>
            )}
          </dd>
          <dt>排除范围</dt>
          <dd>{cmp.scheme.exclusionNote}</dd>
        </dl>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          {cmp.scheme.note} 切换学校不会让参照悄悄改变；不同学校各自删掉缺失层后重新归一化的数值不属于同口径，本工具不采用。
        </p>
      </div>

      <div className="card">
        <h2>一、各餐别原始计数、比例和覆盖</h2>
        <table className="data">
          <thead>
            <tr>
              <th>餐别</th>
              {analysis.schools.map((s) => (
                <th key={s.schoolId} colSpan={2}>{schoolLabel(s.schoolId)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {analysis.filters.mealTypes.map((m) => {
              const comparable = cmp.comparableStrata.includes(m);
              return (
                <tr key={m}>
                  <td>
                    <b>{mealLabel(m)}</b>{' '}
                    {!comparable && <span className="badge candidate">不可比层</span>}
                  </td>
                  {analysis.schools.map((s) => {
                    const t = s.strata.find((x) => x.mealType === m)!;
                    return (
                      <td key={s.schoolId} colSpan={2}>
                        <div style={{ fontSize: 12 }}>
                          实际 {t.actual} · 已核实 {t.verified} · 含有 <b style={{ color: 'var(--issue)' }}>{t.contains}</b> ·
                          未知 <b style={{ color: 'var(--candidate)' }}>{t.unknown}</b>
                          {t.gaps > 0 && <span className="badge issue" style={{ marginLeft: 4 }}>缺口 {t.gaps}</span>}
                        </div>
                        <div style={{ fontSize: 13, margin: '2px 0' }}>
                          已核实比例：<b>{t.verifiedRatio === null ? '无样本' : fmtPct(t.verifiedRatio)}</b>
                          {t.lowerBound !== null && t.upperBound !== null && (
                            <span className="muted" style={{ fontSize: 11 }}>
                              {' '}· 边界 [{fmtPct(t.lowerBound)}, {fmtPct(t.upperBound)}]
                            </span>
                          )}
                        </div>
                        <StratumStackedBar contains={t.contains} notFound={t.notFound} unknown={t.unknown} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12 }}>
          已核实比例只覆盖已核实子集；「无样本」层不能用零比例填补。点击「供餐指标」页分层行可下钻原始供餐记录。
        </p>
      </div>

      <div className="card">
        <h2>二、总体构成（为什么合并顺序可能与餐别内顺序相反）</h2>
        <table className="data">
          <thead>
            <tr>
              <th>学校</th>
              <th className="num">已核实合并比例</th>
              {analysis.filters.mealTypes.map((m) => (
                <th key={m} className="num">{mealLabel(m)}占已核实记录</th>
              ))}
              <th className="num">未知范围</th>
            </tr>
          </thead>
          <tbody>
            {analysis.schools.map((s) => (
              <tr key={s.schoolId}>
                <td><b>{schoolLabel(s.schoolId)}</b></td>
                <td className="num"><b>{fmtPct(s.verifiedRatioMerged)}</b></td>
                {analysis.filters.mealTypes.map((m) => {
                  const sh = structure.find((x) => x.schoolId === s.schoolId)?.shares.find((x) => x.mealType === m);
                  return (
                    <td key={m} className="num">
                      {sh ? `${(sh.share * 100).toFixed(1)}%（${sh.verified} 条）` : '—'}
                    </td>
                  );
                })}
                <td className="num">{s.totals.unknown} 条无法判定 + {s.reconciliation.gaps} 个缺口</td>
              </tr>
            ))}
          </tbody>
        </table>
        {reversal && twoSchools ? (
          <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
            餐别内顺序与合并顺序相反：各餐别内均为{schoolLabel(reversal.withinHigher)}更高，
            但合并后{schoolLabel(reversal.mergedHigher)}更高。差异来自供餐结构（各校已核实记录的餐别构成不同），
            继续按一个总百分比排队会同时掩盖缺报和结构差异。
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            当前范围内餐别内顺序与合并顺序未出现完全相反；仍建议按餐别分层阅读，避免结构差异掩盖缺报。
          </p>
        )}
      </div>

      <div className="card">
        <h2>三、直接标准化调整（同一参照结构；展开查看各层权重、计数与贡献）</h2>
        <div className={`banner ${cmp.canConclude ? 'info' : 'warn'}`}>{cmp.conclusion}</div>
        {cmp.schools.map((s) => (
          <div key={s.schoolId} className="subcard" style={{ marginBottom: 12 }}>
            <h3>
              {schoolLabel(s.schoolId)} 调整值：
              <b style={{ fontSize: 18 }}>{s.adjusted === null ? '无法完成完整调整' : fmtPct(s.adjusted)}</b>
              {s.interval && (
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                  边界 [{fmtPct(s.interval.lower)}, {fmtPct(s.interval.upper)}]
                </span>
              )}
            </h3>
            {!s.complete && (
              <ul style={{ margin: '4px 0', paddingLeft: 18, color: 'var(--issue)', fontSize: 13 }}>
                {s.incompleteReasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
            {s.interval && <IntervalBar lower={s.interval.lower} upper={s.interval.upper} />}
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              onClick={() => setExpandAdjusted(expandAdjusted === s.schoolId ? null : s.schoolId)}
            >
              {expandAdjusted === s.schoolId ? '收起分层贡献' : '展开各层权重、计数与贡献'}
            </button>
            {expandAdjusted === s.schoolId && (
              <table className="data" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>餐别层</th>
                    <th className="num">参照权重</th>
                    <th className="num">已核实比例</th>
                    <th className="num">含有/已核实/实际</th>
                    <th className="num">未知</th>
                    <th className="num">层内缺口</th>
                    <th className="num">贡献 = 权重 × 比例</th>
                  </tr>
                </thead>
                <tbody>
                  {s.contributions.map((c) => (
                    <tr key={c.mealType}>
                      <td>{mealLabel(c.mealType)}</td>
                      <td className="num">{fmtPct(c.weight)}</td>
                      <td className="num">{c.verifiedRatio === null ? '无样本' : fmtPct(c.verifiedRatio)}</td>
                      <td className="num">{c.contains} / {c.verified} / {c.actual}</td>
                      <td className="num">{c.unknown}</td>
                      <td className="num">{c.gapFlag ? <b style={{ color: 'var(--issue)' }}>{c.gaps}</b> : 0}</td>
                      <td className="num"><b>{c.contribution === null ? '—' : fmtPct(c.contribution)}</b></td>
                    </tr>
                  ))}
                  <tr>
                    <td><b>合计</b></td>
                    <td className="num"><b>100.0%</b></td>
                    <td colSpan={4} className="muted" style={{ fontSize: 12 }}>
                      调整值 = Σ（各层参照权重 × 该层已核实比例）；层内缺口只标注不清零
                    </td>
                    <td className="num"><b>{s.adjusted === null ? '—' : fmtPct(s.adjusted)}</b></td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>四、可比范围（留下与舍弃的学校、窗口、餐别和记录范围）</h2>
        <p style={{ fontSize: 13 }}>
          可比餐别层（双方均有可核实资料）：
          {cmp.comparableStrata.length > 0 ? cmp.comparableStrata.map(mealLabel).join('、') : '无'}；
          不可比层：
          {cmp.incomparableStrata.length > 0
            ? cmp.incomparableStrata.map((x) => `${mealLabel(x.mealType)}（缺：${x.missingSchools.map(schoolLabel).join('、')}）`).join('、')
            : '无'}
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          留下：{included.length} 条实际供餐记录进入指标（学校/窗口/餐别范围见筛选）；舍弃（不计入实际供餐分母）：
          {excluded.length} 条（明确停业/零供餐与未解释缺口）。
          {cmp.incomparableStrata.length > 0 && ' 当前只得到局部可比结果，结论不外推到全校。'}
        </p>
        <button className="btn small" onClick={() => setShowExcluded(!showExcluded)}>
          {showExcluded ? '收起' : '展开'}舍弃记录清单（{excluded.length}）
        </button>
        {showExcluded && (
          <table className="data" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>学校/窗口/日期/餐别</th><th>状态</th><th>排除原因</th><th></th></tr>
            </thead>
            <tbody>
              {excluded.map((r) => (
                <tr key={r.key}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {schoolLabel(r.schoolId)} {r.serviceWindow} · {r.bizDate} · {mealLabel(r.mealType)}
                  </td>
                  <td>{r.status === 'GAP' ? '未解释缺口' : r.status === 'CLOSED' ? '明确停业' : '明确零供餐'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.inclusionReason}</td>
                  <td><button className="btn small" onClick={() => setPick(r)}>下钻</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>方法说明：为什么选直接标准化</h2>
        <p style={{ fontSize: 13 }}>
          本工具用于<b>跨校比较和后续追踪</b>，选择<b>直接标准化</b>：各校按同一种固定参照餐别结构计算调整值，
          保留各层数据、便于与固定参照持续比较；参照中某层缺少可核实资料时不能完成该校的完整调整值，
          权重随比较范围显式明确。
        </p>
        <p style={{ fontSize: 13 }}>
          另一种方法<b>分层匹配</b>（只在双方都有充分资料的餐别中比较）适用于：缺报严重、只需要一个可解释的局部结果、
          且结论明确不外推到全校的场合。它舍弃不少真实供餐记录，结论只适用于匹配部分。
          本选择牺牲的是：当某校某层缺少可核实资料时，我们不给出该校的任何单一调整数值
          （宁可标注「无法完成完整调整」，也不用删层重归一化的伪同口径数值）。
        </p>
        <div className="pill-group">
          <button className="btn" onClick={exportJson}>导出比较结果 JSON</button>
          <button className="btn" onClick={() => downloadCsv('school-compare-records.csv', supplyRecordsToCsv(analysis))}>
            导出供餐记录 CSV
          </button>
          <Link className="btn" to="/supply">返回供餐指标</Link>
        </div>
      </div>

      {pick && <SupplyRecordDrawer record={pick} dataset={dataset} onClose={() => setPick(null)} />}
    </div>
  );
}

function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}
