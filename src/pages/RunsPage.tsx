import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { BucketBadge } from '../components/Badges';
import { CoverageBar } from '../components/Coverage';
import { assessmentsToCsv, buildRunExport, downloadCsv, downloadJson } from '../lib/export';
import { shortHash } from '../lib/hash';
import type { AnalysisRun } from '../types';

export function RunsPage() {
  const { runs, createRun, removeRun, resetWorkspace } = useAppState();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2600);
  };

  const onCreate = async () => {
    setBusy(true);
    try {
      const run = await createRun();
      flash(`已生成新运行 ${run.summary.runId}（旧运行保持不变）`);
    } finally {
      setBusy(false);
    }
  };

  const exportJson = (run: AnalysisRun) => {
    downloadJson(`${run.summary.runId}-allergen-coverage.json`, buildRunExport(run, new Date().toISOString()));
  };

  return (
    <div>
      <h1 className="page-title">分析运行（不可变快照）</h1>
      <p className="page-desc">
        每次运行固定引用输入文件哈希、映射版本（含修订号）与规则版本。补发旧数据或映射改变后生成的是<b>新运行</b>，
        历史运行不会被静默改写；请在「运行对比」页查看覆盖率与记录桶位的变化。
      </p>

      <div className="filter-bar">
        <button className="btn primary" disabled={busy} onClick={() => void onCreate()}>
          {busy ? '计算中…' : '基于当前映射生成新运行'}
        </button>
        <Link className="btn" to="/compare">前往运行对比</Link>
        <button
          className="btn danger"
          onClick={() => {
            if (window.confirm('将清空 IndexedDB 中的映射修订、运行与快照，并恢复随项目提供的种子映射。确定？')) {
              void resetWorkspace().then(() => flash('工作区已重置为种子状态'));
            }
          }}
        >
          重置工作区
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="card empty">
          尚无已保存运行。点击上方按钮生成第一个运行；运行结果将保存在浏览器 IndexedDB，不上传任何数据。
        </div>
      ) : (
        <div className="card">
          <table className="data">
            <thead>
              <tr>
                <th>运行编号</th>
                <th>生成时间</th>
                <th>映射 / 规则版本</th>
                <th>覆盖（确认/候选/未知）</th>
                <th className="num">确认暴露</th>
                <th>输入哈希</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.summary.runId}>
                  <td>
                    <Link to={`/runs/${r.summary.runId}`}><b className="mono">{r.summary.runId}</b></Link>
                  </td>
                  <td className="nowrap">{new Date(r.summary.createdAt).toLocaleString('zh-CN')}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {r.summary.mappingVersion} r{r.summary.mappingRevision}
                    <br />{r.summary.ruleVersion}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    <CoverageBar coverage={r.summary.coverage} />
                    <div style={{ marginTop: 6 }}>
                      <BucketBadge bucket="CONFIRMED" /> 等三桶明细见运行详情
                    </div>
                  </td>
                  <td className="num">{r.summary.confirmedExposures}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {Object.keys(r.summary.inputHashes).length} 个文件
                    <br />manifest {shortHash(r.summary.inputHashes.manifest ?? '')}
                  </td>
                  <td>
                    <div className="pill-group">
                      <Link className="btn small" to={`/runs/${r.summary.runId}`}>详情/下钻</Link>
                      <button className="btn small" onClick={() => exportJson(r)}>导出 JSON</button>
                      <button className="btn small" onClick={() => downloadCsv(`${r.summary.runId}.csv`, assessmentsToCsv(r))}>
                        导出 CSV
                      </button>
                      <button className="btn small danger" onClick={() => void removeRun(r.summary.runId)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
