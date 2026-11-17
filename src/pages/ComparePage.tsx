import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { diffRuns } from '../engine/runEngine';
import { BUCKET_LABEL } from '../lib/export';
import { QUALITY_LABEL } from '../engine/quality';
import type { EvidenceBucket } from '../types';

const BUCKETS: EvidenceBucket[] = ['CONFIRMED', 'CANDIDATE_PENDING', 'UNKNOWN_MISSING'];

export function ComparePage() {
  const { runs } = useAppState();
  const [baseId, setBaseId] = useState('');
  const [targetId, setTargetId] = useState('');

  const base = runs.find((r) => r.summary.runId === baseId);
  const target = runs.find((r) => r.summary.runId === targetId);
  const diff = useMemo(() => (base && target ? diffRuns(base, target) : null), [base, target]);

  return (
    <div>
      <h1 className="page-title">运行对比：变更不会静默改写旧结论</h1>
      <p className="page-desc">
        选择两个已保存运行，查看领餐记录在「有证据 / 候选待确认 / 来源缺失未知」三桶之间的迁移、
        覆盖率变化以及质量问题的新增与解除。晚到批次补发或映射规则改变后，请用新运行与旧运行对照说明影响范围。
      </p>

      <div className="card">
        <div className="filter-bar">
          <label>
            基准运行（旧）：
            <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={{ marginLeft: 8, minWidth: 220 }}>
              <option value="">请选择…</option>
              {runs.map((r) => <option key={r.summary.runId} value={r.summary.runId}>{r.summary.runId}（{r.summary.mappingVersion} r{r.summary.mappingRevision}）</option>)}
            </select>
          </label>
          <label>
            对照运行（新）：
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ marginLeft: 8, minWidth: 220 }}>
              <option value="">请选择…</option>
              {runs.map((r) => <option key={r.summary.runId} value={r.summary.runId}>{r.summary.runId}（{r.summary.mappingVersion} r{r.summary.mappingRevision}）</option>)}
            </select>
          </label>
        </div>
        {runs.length < 2 && (
          <div className="banner warn">
            至少需要两个已保存运行才能对比。请先在「映射工作台」修改映射（例如确认一个候选），
            或等待晚到批次到齐后重新加载，再到「分析运行」页分别生成运行。
          </div>
        )}
      </div>

      {diff && base && target && (
        <>
          <div className="card">
            <h2>固定引用差异</h2>
            <table className="data">
              <thead><tr><th>项</th><th>基准 {base.summary.runId}</th><th>对照 {target.summary.runId}</th></tr></thead>
              <tbody>
                <tr><td>映射版本 / 修订</td><td className="mono">{base.summary.mappingVersion} r{base.summary.mappingRevision}</td><td className="mono">{target.summary.mappingVersion} r{target.summary.mappingRevision}</td></tr>
                <tr><td>规则版本</td><td className="mono">{base.summary.ruleVersion}</td><td className="mono">{target.summary.ruleVersion}</td></tr>
                <tr>
                  <td>输入哈希是否一致</td>
                  <td colSpan={2}>
                    {JSON.stringify(base.summary.inputHashes) === JSON.stringify(target.summary.inputHashes)
                      ? <span className="badge ok">输入文件完全一致（差异仅来自映射/规则）</span>
                      : <span className="badge issue">输入哈希不同（存在晚到补发或数据修订）</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>覆盖率变化</h2>
            <table className="data">
              <thead><tr><th>桶</th><th className="num">基准</th><th className="num">对照</th><th className="num">变化</th></tr></thead>
              <tbody>
                <tr><td>{BUCKET_LABEL.CONFIRMED}</td><td className="num">{diff.coverageBefore.confirmed}</td><td className="num">{diff.coverageAfter.confirmed}</td><td className="num">{signed(diff.coverageAfter.confirmed - diff.coverageBefore.confirmed)}</td></tr>
                <tr><td>{BUCKET_LABEL.CANDIDATE_PENDING}</td><td className="num">{diff.coverageBefore.candidatePending}</td><td className="num">{diff.coverageAfter.candidatePending}</td><td className="num">{signed(diff.coverageAfter.candidatePending - diff.coverageBefore.candidatePending)}</td></tr>
                <tr><td>{BUCKET_LABEL.UNKNOWN_MISSING}</td><td className="num">{diff.coverageBefore.unknownMissing}</td><td className="num">{diff.coverageAfter.unknownMissing}</td><td className="num">{signed(diff.coverageAfter.unknownMissing - diff.coverageBefore.unknownMissing)}</td></tr>
                <tr><td>总数</td><td className="num">{diff.coverageBefore.total}</td><td className="num">{diff.coverageAfter.total}</td><td className="num">{signed(diff.coverageAfter.total - diff.coverageBefore.total)}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>领餐记录桶位迁移矩阵（行=基准桶，列=对照桶）</h2>
            <table className="data diff-matrix">
              <thead>
                <tr>
                  <th>基准 ＼ 对照</th>
                  {BUCKETS.map((b) => <th key={b}>{BUCKET_LABEL[b]}</th>)}
                </tr>
              </thead>
              <tbody>
                {BUCKETS.map((rb) => (
                  <tr key={rb}>
                    <td style={{ textAlign: 'left' }}><b>{BUCKET_LABEL[rb]}</b></td>
                    {BUCKETS.map((cb) => (
                      <td key={cb} className={rb === cb ? 'diag' : diff.changedServingBuckets[rb][cb] > 0 ? 'changed' : ''}>
                        {diff.changedServingBuckets[rb][cb]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              对角线为桶位未变的记录；高亮单元格为实际迁移量。共 {diff.changedServingIds.length} 条领餐桶位发生变化：
              <span className="mono"> {diff.changedServingIds.slice(0, 15).join('、')}{diff.changedServingIds.length > 15 ? ' …' : ''}</span>
            </p>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>新增质量问题（{diff.newIssues.length}）</h2>
              {diff.newIssues.length === 0 ? <p className="muted">无</p> : diff.newIssues.map((i, idx) => (
                <div key={idx} className="candidate-card">
                  <span className="badge issue">{QUALITY_LABEL[i.type]}</span> {i.message}
                  <div className="muted mono" style={{ fontSize: 11 }}>{i.batchId}</div>
                </div>
              ))}
            </div>
            <div className="card">
              <h2>已解除质量问题（{diff.resolvedIssues.length}）</h2>
              {diff.resolvedIssues.length === 0 ? <p className="muted">无</p> : diff.resolvedIssues.map((i, idx) => (
                <div key={idx} className="candidate-card">
                  <span className="badge ok">{QUALITY_LABEL[i.type]}</span> {i.message}
                  <div className="muted mono" style={{ fontSize: 11 }}>{i.batchId}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
