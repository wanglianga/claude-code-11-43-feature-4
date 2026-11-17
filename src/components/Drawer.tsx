import type { ReactNode } from 'react';

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label={title}>
        <button className="btn small close" onClick={onClose}>
          关闭 ✕
        </button>
        <h2>{title}</h2>
        {subtitle && <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>}
        <div style={{ marginTop: 16 }}>{children}</div>
      </div>
    </>
  );
}

export function RawRowView({ batchId, lineNo, values }: { batchId: string; lineNo: number; values: Record<string, string> }) {
  return (
    <div className="raw-row">
      <div className="rowid mono">
        {batchId}#L{lineNo}
      </div>
      <dl className="kv-list" style={{ gridTemplateColumns: '120px 1fr', marginTop: 6 }}>
        {Object.entries(values).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd className="mono">{v === '' ? <span className="muted">（空值）</span> : v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
