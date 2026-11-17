import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAppState } from './state/AppState';
import { OverviewPage } from './pages/OverviewPage';
import { SourcesPage } from './pages/SourcesPage';
import { MappingPage } from './pages/MappingPage';
import { QualityPage } from './pages/QualityPage';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ComparePage } from './pages/ComparePage';
import { SupplyPage } from './pages/SupplyPage';
import { SchoolComparePage } from './pages/SchoolComparePage';
import { SupplyStaleBanner } from './components/SupplyStaleBanner';

const NAV = [
  { to: '/overview', label: '总览', icon: '📊' },
  { to: '/sources', label: '来源批次', icon: '🗂️' },
  { to: '/mapping', label: '映射工作台', icon: '🔗' },
  { to: '/quality', label: '质量检查', icon: '🧪' },
  { to: '/runs', label: '分析运行', icon: '▶️' },
  { to: '/compare', label: '运行对比', icon: '🆚' },
  { to: '/supply', label: '供餐指标', icon: '🍽️' },
  { to: '/school-compare', label: '跨校比较', icon: '⚖️' },
];

function ConflictBanner() {
  const { conflict, reloadMapping, dismissConflict } = useAppState();
  if (!conflict) return null;
  return (
    <div className="banner error">
      <b>映射版本冲突：</b>另一个浏览器标签页已保存更新版本（r{conflict.remoteRevision}，
      {new Date(conflict.remoteModifiedAt).toLocaleString('zh-CN')}）。你的编辑基于 r{conflict.localRevision}，
      为避免覆盖已确认映射，本次保存已被拒绝。
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button className="btn primary small" onClick={() => void reloadMapping()}>
          重载最新映射
        </button>
        <button className="btn small" onClick={dismissConflict}>
          我知道了
        </button>
      </div>
    </div>
  );
}

export function AppRoutes() {
  const { mappingState } = useAppState();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>校园供餐数据质量与<br />过敏原覆盖分析</h1>
        <p className="subtitle">浏览器端 · 本地 IndexedDB · 不联网不上传</p>
        <nav>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <span>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="footnote">
          当前映射版本：{mappingState?.doc.mappingVersion} · r{mappingState?.revision}
          <br />
          规则版本：{mappingState?.doc.ruleVersion}
          <br />
          所有统计仅由本地样例输入生成
        </div>
      </aside>
      <main className="main">
        <ConflictBanner />
        <SupplyStaleBanner />
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/mapping" element={<MappingPage />} />
          <Route path="/quality" element={<QualityPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/supply" element={<SupplyPage />} />
          <Route path="/school-compare" element={<SchoolComparePage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
    </div>
  );
}
