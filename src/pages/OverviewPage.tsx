import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { computeBatchStats } from '../lib/batchStats';
import { BATCH_LABEL, SOURCE_SCHEMAS } from '../lib/schema';
import { CoverageDonut } from '../components/Coverage';
import { Badge } from '../components/Badges';
import { shortHash } from '../lib/hash';
import { Drawer } from '../components/Drawer';
import type { MetricDetail } from '../types';

export function OverviewPage() {
  const { dataset, currentRun, mappingState } = useAppState();
  const [metric, setMetric] = useState<MetricDetail | null>(null);

  const stats = useMemo(
    () => (dataset && currentRun ? computeBatchStats(dataset, currentRun) : []),
    [dataset, currentRun],
  );

  if (!dataset || !currentRun || !mappingState) return null;
  const c = currentRun.summary.coverage;

  return (
    <div>
      <h1 className="page-title">总览：来源批次与证据覆盖</h1>
      <p className="page-desc">
        每个来源批次独立展示输入行数、有效行数、重复行数、成功关联数与未知数。未匹配记录计为「未知」而非「无过敏原」，
        「计划使用」不参与实际暴露统计。当前口径固定引用映射 {mappingState.doc.mappingVersion}（r{mappingState.revision}）
        与规则 {mappingState.doc.ruleVersion}。
      </p>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <div className="stat confirmed">
          <div className="label">有证据支持的匹配</div>
          <div className="value">{c.confirmed}</div>
          <div className="hint">精确编码 / 批准别名 / 人工确认</div>
        </div>
        <div className="stat candidate">
          <div className="label">存在候选但需确认</div>
          <div className="value">{c.candidatePending}</div>
          <div className="hint">确认后才进入正式统计</div>
        </div>
        <div className="stat unknown">
          <div className="label">来源缺失无法判定</div>
          <div className="value">{c.unknownMissing}</div>
          <div className="hint">不等于「确认无过敏原」</div>
        </div>
        <div className="stat">
          <div className="label">领餐记录总数（分母）</div>
          <div className="value">{c.total}</div>
          <div className="hint">已到齐来源中的全部领餐</div>
        </div>
      </div>

      <div className="card">
        <h2>三桶证据覆盖（按领餐记录）</h2>
        <CoverageDonut coverage={c} />
      </div>

      <div className="card">
        <h2>指标详情（分子 / 分母 / 排除条件 / 来源范围）</h2>
        <table className="data">
          <thead>
            <tr>
              <th>指标</th>
              <th className="num">分子</th>
              <th className="num">分母</th>
              <th className="num">当前值</th>
              <th>口径说明</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {currentRun.metricDetails.map((m) => (
              <tr key={m.key}>
                <td><b>{m.label}</b></td>
                <td className="num">{m.numerator}</td>
                <td className="num">{m.denominator}</td>
                <td className="num">
                  {m.denominator === 0 ? '—' : `${((m.numerator / m.denominator) * 100).toFixed(1)}%`}
                </td>
                <td className="muted" style={{ maxWidth: 380 }}>{m.explanation}</td>
                <td>
                  <button className="btn small" onClick={() => setMetric(m)}>查看口径</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>来源批次健康度</h2>
        <table className="data">
          <thead>
            <tr>
              <th>批次</th>
              <th>来源类型 / 学校</th>
              <th>状态</th>
              <th className="num">输入行数</th>
              <th className="num">有效行数</th>
              <th className="num">重复行数</th>
              <th className="num">缺失键行</th>
              <th className="num">成功关联</th>
              <th className="num">候选待确认</th>
              <th className="num">未知</th>
              <th>文件哈希</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.meta.batchId}>
                <td>
                  <Link to="/sources">{BATCH_LABEL(s.meta)}</Link>
                  <div className="muted mono" style={{ fontSize: 11 }}>{s.meta.batchId}</div>
                </td>
                <td>{SOURCE_SCHEMAS[s.meta.sourceType].label}</td>
                <td>
                  {s.meta.status === 'PENDING' ? (
                    <Badge tone="candidate">未到齐</Badge>
                  ) : (
                    <Badge tone="ok">已到齐</Badge>
                  )}
                </td>
                <td className="num">{s.meta.status === 'PENDING' ? `预期 ${s.meta.expectedRows}` : s.inputRows}</td>
                <td className="num">{s.validRows}</td>
                <td className="num">{s.duplicateRows > 0 ? <b style={{ color: 'var(--issue)' }}>{s.duplicateRows}</b> : 0}</td>
                <td className="num">{s.missingKeyRows > 0 ? <b style={{ color: 'var(--issue)' }}>{s.missingKeyRows}</b> : 0}</td>
                <td className="num" style={{ color: 'var(--confirmed)', fontWeight: 700 }}>{s.linkedRows}</td>
                <td className="num" style={{ color: 'var(--candidate)', fontWeight: 700 }}>{s.candidateRows}</td>
                <td className="num" style={{ color: 'var(--unknown)', fontWeight: 700 }}>{s.unknownRows}</td>
                <td className="mono muted">{s.fileHash ? shortHash(s.fileHash) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          批次晚到（sup-a-2，数据日期 2026-09-02 但 09-10 才更新）与未到齐（kit-b-2）已在清单中标注；
          未到齐批次不产生输入行，其预期行数计入未知范围，而不会被当成零暴露。
        </p>
      </div>

      {metric && (
        <Drawer title={metric.label} subtitle="指标口径详情" onClose={() => setMetric(null)}>
          <dl className="kv-list">
            <dt>分子</dt><dd>{metric.numerator}</dd>
            <dt>分母</dt><dd>{metric.denominator}</dd>
            <dt>当前值</dt>
            <dd>{metric.denominator === 0 ? '—' : `${((metric.numerator / metric.denominator) * 100).toFixed(1)}%`}</dd>
            <dt>排除条件</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {metric.exclusions.map((e) => <li key={e}>{e}</li>)}
              </ul>
            </dd>
            <dt>来源范围</dt>
            <dd className="mono">{metric.sourceScope.join('、')}</dd>
            <dt>解释</dt><dd>{metric.explanation}</dd>
          </dl>
        </Drawer>
      )}
    </div>
  );
}
