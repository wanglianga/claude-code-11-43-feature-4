import { useAppState } from '../state/AppState';

/** 跨标签页补传提示：另一标签页提交补传后，本页旧结果不得作为新范围结论 */
export function SupplyStaleBanner() {
  const { supplyStale, applyRemoteActivation, dismissSupplyStale } = useAppState();
  if (!supplyStale) return null;
  return (
    <div className="banner warn">
      <b>另一标签页已提交补传（r{supplyStale.remoteRevision}）。</b>
      当前页面结果基于旧范围（r{supplyStale.localRevision}），不能作为新范围的当前结论。
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button className="btn primary small" onClick={() => void applyRemoteActivation()}>
          应用新范围并重新计算
        </button>
        <button className="btn small" onClick={dismissSupplyStale}>保留旧范围，我知道了</button>
      </div>
    </div>
  );
}
