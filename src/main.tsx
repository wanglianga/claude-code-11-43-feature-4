import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AppStateProvider, useAppState } from './state/AppState';
import { AppRoutes } from './App';
import './styles.css';

function Gate() {
  const { loading, loadError } = useAppState();
  if (loadError) {
    return (
      <div style={{ padding: 40 }}>
        <div className="banner error">
          样例数据加载失败：{loadError}
          <div className="muted" style={{ marginTop: 6 }}>
            请通过 npm run dev 或 Docker 启动（需要 HTTP 服务读取 /sample-data），不要直接打开 index.html。
          </div>
        </div>
      </div>
    );
  }
  if (loading) {
    return <div style={{ padding: 40 }} className="muted">正在加载样例数据并计算输入哈希…</div>;
  }
  return <AppRoutes />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppStateProvider>
        <Gate />
      </AppStateProvider>
    </HashRouter>
  </React.StrictMode>,
);
