import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AnalysisRun, MappingDocument, MappingState, SupplyFilters, SupplyRun } from '../types';
import { loadDataset, type Dataset } from '../lib/loadDataset';
import {
  KV_KEYS,
  clearAll,
  deleteRun as idbDeleteRun,
  deleteSupplyRun as idbDeleteSupplyRun,
  getAllRuns,
  getAllSnapshots,
  getAllSupplyRuns,
  kvGet,
  kvSet,
  saveRun,
  saveSnapshot,
  saveSupplyRun as idbSaveSupplyRun,
  type SupplyActivationState,
} from '../lib/db';
import { runEngine } from '../engine/runEngine';
import { RULE_VERSION } from '../engine/rules';
import {
  DEFAULT_COMPARISON_SCHEME,
  DEFAULT_FILTERS,
  runSupplyAnalysis,
} from '../engine/supplyEngine';
import type { ComparisonScheme, SupplyAnalysis } from '../types';

export interface MappingConflict {
  localRevision: number;
  remoteRevision: number;
  remoteModifiedAt: string;
}

export interface SupplyStaleNotice {
  localRevision: number;
  remoteRevision: number;
  remoteModifiedAt: string;
}

interface AppStateValue {
  dataset: Dataset | null;
  mappingState: MappingState | null;
  runs: AnalysisRun[];
  loading: boolean;
  loadError: string | null;
  conflict: MappingConflict | null;
  currentRun: AnalysisRun | null;
  refreshCurrentRun: () => void;
  saveMapping: (draft: MappingDocument, baseRevision: number) => Promise<void>;
  reloadMapping: () => Promise<void>;
  createRun: (note?: string) => Promise<AnalysisRun>;
  removeRun: (runId: string) => Promise<void>;
  resetWorkspace: () => Promise<void>;
  dismissConflict: () => void;
  // ---- 跨校供餐指标 ----
  supplyFilters: SupplyFilters;
  setSupplyFilters: (f: SupplyFilters) => void;
  supplyAllergen: string;
  setSupplyAllergen: (a: string) => void;
  comparisonScheme: ComparisonScheme;
  supplyActivation: SupplyActivationState | null;
  /** 另一标签页已提交补传：当前结果基于旧范围，不得作为新范围结论 */
  supplyStale: SupplyStaleNotice | null;
  currentSupply: SupplyAnalysis | null;
  activateLateBatch: (batchId: string) => Promise<void>;
  applyRemoteActivation: () => Promise<void>;
  dismissSupplyStale: () => void;
  supplyRuns: SupplyRun[];
  saveSupplyRun: (note?: string, analysisOverride?: SupplyAnalysis) => Promise<SupplyRun>;
  removeSupplyRun: (runId: string) => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

const CHANNEL_NAME = 'campus-meal-dq-mapping';
const SUPPLY_CHANNEL_NAME = 'campus-meal-dq-supply';

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [mappingState, setMappingState] = useState<MappingState | null>(null);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MappingConflict | null>(null);
  const [currentRun, setCurrentRun] = useState<AnalysisRun | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const mappingStateRef = useRef<MappingState | null>(null);
  mappingStateRef.current = mappingState;

  // ---- 跨校供餐指标状态 ----
  const [supplyFilters, setSupplyFilters] = useState<SupplyFilters>(DEFAULT_FILTERS);
  const [supplyAllergen, setSupplyAllergen] = useState('乳');
  const [comparisonScheme, setComparisonScheme] = useState<ComparisonScheme>(DEFAULT_COMPARISON_SCHEME);
  const [supplyActivation, setSupplyActivation] = useState<SupplyActivationState | null>(null);
  const [supplyStale, setSupplyStale] = useState<SupplyStaleNotice | null>(null);
  const [supplyRuns, setSupplyRuns] = useState<SupplyRun[]>([]);
  const supplyChannelRef = useRef<BroadcastChannel | null>(null);
  const supplyActivationRef = useRef<SupplyActivationState | null>(null);
  supplyActivationRef.current = supplyActivation;

  const refreshCurrentRun = useCallback(() => {
    if (!dataset || !mappingStateRef.current) return;
    setCurrentRun(runEngine(dataset, mappingStateRef.current.doc, { mappingRevision: mappingStateRef.current.revision }));
  }, [dataset]);

  const reloadMapping = useCallback(async () => {
    const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
    if (fresh) {
      setMappingState(fresh);
      setConflict(null);
      if (dataset) setCurrentRun(runEngine(dataset, fresh.doc, { mappingRevision: fresh.revision }));
    }
  }, [dataset]);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      try {
        const ds = await loadDataset();
        if (!mounted) return;
        setDataset(ds);

        // 输入快照：记录本次分析固定引用的文件哈希
        await saveSnapshot({
          id: `input-${ds.metaHashes.manifest.slice(0, 10)}`,
          kind: 'INPUT_SNAPSHOT',
          createdAt: new Date().toISOString(),
          payload: {
            manifestHash: ds.metaHashes.manifest,
            fileHashes: ds.hashes,
            batches: ds.manifest.batches.map((b) => ({
              batchId: b.batchId,
              status: b.status,
              expectedRows: b.expectedRows,
            })),
          },
        });

        let state = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (!state) {
          // 首次进入：以随项目提供的种子映射初始化
          state = {
            doc: ds.seedMapping,
            revision: 1,
            lastModifiedAt: ds.seedMapping.updatedAt,
          };
          await kvSet(KV_KEYS.mappingState, state);
        }
        // 供餐指标：补传激活状态与比较方案（固定参照构成）
        let activation = await kvGet<SupplyActivationState>(KV_KEYS.supplyActivation);
        if (!activation) {
          activation = { activated: [], revision: 1, modifiedAt: new Date().toISOString() };
          await kvSet(KV_KEYS.supplyActivation, activation);
        }
        let scheme = await kvGet<ComparisonScheme>(KV_KEYS.comparisonScheme);
        if (!scheme) {
          scheme = DEFAULT_COMPARISON_SCHEME;
          await kvSet(KV_KEYS.comparisonScheme, scheme);
        }
        if (!mounted) return;
        setMappingState(state);
        setSupplyActivation(activation);
        setComparisonScheme(scheme);
        setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
        setRuns(await getAllRuns());
        setSupplyRuns(await getAllSupplyRuns());
        await getAllSnapshots(); // 触发索引，快照可在后续页面读取
        setLoading(false);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    bootstrap();

    // 跨标签页：其他标签页保存映射后广播，当前标签页检测版本落后即进入冲突态
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async (ev: MessageEvent<{ type: string; revision: number; modifiedAt: string }>) => {
      if (ev.data?.type !== 'mapping-saved') return;
      const local = mappingStateRef.current;
      if (local && ev.data.revision > local.revision) {
        const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (fresh) {
          setMappingState(fresh);
          setConflict({
            localRevision: local.revision,
            remoteRevision: ev.data.revision,
            remoteModifiedAt: ev.data.modifiedAt,
          });
        }
      }
    };

    // 跨标签页：另一标签页提交补传后，本标签页当前结果基于旧范围，标记过期而非静默替换
    const supplyChannel = new BroadcastChannel(SUPPLY_CHANNEL_NAME);
    supplyChannelRef.current = supplyChannel;
    supplyChannel.onmessage = async (
      ev: MessageEvent<{ type: string; revision: number; modifiedAt: string }>,
    ) => {
      if (ev.data?.type !== 'supply-activation-saved') return;
      const local = supplyActivationRef.current;
      if (local && ev.data.revision > local.revision) {
        setSupplyStale({
          localRevision: local.revision,
          remoteRevision: ev.data.revision,
          remoteModifiedAt: ev.data.modifiedAt,
        });
      }
    };

    return () => {
      mounted = false;
      channel.close();
      supplyChannel.close();
    };
  }, []);

  const saveMapping = useCallback(
    async (draft: MappingDocument, baseRevision: number) => {
      if (!dataset) throw new Error('数据尚未加载完成');
      // 保存时重新读取 IDB：若另一标签页已提交更高版本，拒绝覆盖并要求重载
      const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
      if (fresh && fresh.revision !== baseRevision) {
        setMappingState(fresh);
        setConflict({
          localRevision: baseRevision,
          remoteRevision: fresh.revision,
          remoteModifiedAt: fresh.lastModifiedAt,
        });
        throw new MappingSaveConflictError(fresh.revision);
      }
      const now = new Date().toISOString();
      const next: MappingState = {
        doc: { ...draft, ruleVersion: RULE_VERSION, updatedAt: now },
        revision: (fresh?.revision ?? baseRevision) + 1,
        lastModifiedAt: now,
      };
      await kvSet(KV_KEYS.mappingState, next);
      await saveSnapshot({
        id: `mapping-v${next.revision}-${next.doc.mappingVersion}`,
        kind: 'MAPPING_SNAPSHOT',
        createdAt: now,
        payload: next,
      });
      setMappingState(next);
      setCurrentRun(runEngine(dataset, next.doc, { mappingRevision: next.revision }));
      channelRef.current?.postMessage({
        type: 'mapping-saved',
        revision: next.revision,
        modifiedAt: now,
      });
    },
    [dataset],
  );

  const createRun = useCallback(async () => {
    if (!dataset || !mappingStateRef.current) throw new Error('数据尚未加载完成');
    const state = mappingStateRef.current;
    const run = runEngine(dataset, state.doc, { mappingRevision: state.revision });
    await saveRun(run);
    setRuns(await getAllRuns());
    return run;
  }, [dataset]);

  const removeRun = useCallback(async (runId: string) => {
    await idbDeleteRun(runId);
    setRuns(await getAllRuns());
  }, []);

  const resetWorkspace = useCallback(async () => {
    await clearAll();
    const ds = await loadDataset();
    setDataset(ds);
    const state: MappingState = {
      doc: ds.seedMapping,
      revision: 1,
      lastModifiedAt: ds.seedMapping.updatedAt,
    };
    await kvSet(KV_KEYS.mappingState, state);
    setMappingState(state);
    setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
    setRuns([]);
    setConflict(null);
    // 供餐指标：恢复默认筛选、未激活补传、固定参照
    const activation: SupplyActivationState = { activated: [], revision: 1, modifiedAt: new Date().toISOString() };
    await kvSet(KV_KEYS.supplyActivation, activation);
    await kvSet(KV_KEYS.comparisonScheme, DEFAULT_COMPARISON_SCHEME);
    setSupplyActivation(activation);
    setComparisonScheme(DEFAULT_COMPARISON_SCHEME);
    setSupplyFilters(DEFAULT_FILTERS);
    setSupplyAllergen('乳');
    setSupplyStale(null);
    setSupplyRuns([]);
  }, []);

  // ---- 跨校供餐指标：当前计算（筛选/成分/补传范围变化即整体重算，不只更新图表） ----
  const currentSupply = useMemo<SupplyAnalysis | null>(() => {
    if (!dataset || !mappingState || !supplyActivation) return null;
    return runSupplyAnalysis(dataset, mappingState.doc, {
      allergen: supplyAllergen,
      filters: supplyFilters,
      activatedLateBatches: supplyActivation.activated,
      scheme: comparisonScheme,
      mappingRevision: mappingState.revision,
    });
  }, [dataset, mappingState, supplyActivation, supplyAllergen, supplyFilters, comparisonScheme]);

  /** 确认补传：乐观锁写回激活状态并广播，随后由调用方生成新运行 */
  const activateLateBatch = useCallback(
    async (batchId: string) => {
      const fresh = await kvGet<SupplyActivationState>(KV_KEYS.supplyActivation);
      const local = supplyActivationRef.current;
      if (fresh && local && fresh.revision !== local.revision) {
        // 另一标签页已提交更新的补传：拒绝基于旧范围的写入
        setSupplyStale({
          localRevision: local.revision,
          remoteRevision: fresh.revision,
          remoteModifiedAt: fresh.modifiedAt,
        });
        throw new SupplyActivationConflictError(fresh.revision);
      }
      const base = fresh ?? local ?? { activated: [], revision: 0, modifiedAt: '' };
      const next: SupplyActivationState = {
        activated: base.activated.includes(batchId) ? base.activated : [...base.activated, batchId],
        revision: base.revision + 1,
        modifiedAt: new Date().toISOString(),
      };
      await kvSet(KV_KEYS.supplyActivation, next);
      setSupplyActivation(next);
      supplyChannelRef.current?.postMessage({
        type: 'supply-activation-saved',
        revision: next.revision,
        modifiedAt: next.modifiedAt,
      });
    },
    [],
  );

  /** 接受另一标签页的补传范围并重新计算 */
  const applyRemoteActivation = useCallback(async () => {
    const fresh = await kvGet<SupplyActivationState>(KV_KEYS.supplyActivation);
    if (fresh) setSupplyActivation(fresh);
    setSupplyStale(null);
  }, []);

  const dismissSupplyStale = useCallback(() => setSupplyStale(null), []);

  const saveSupplyRunAction = useCallback(
    async (note?: string, analysisOverride?: SupplyAnalysis) => {
      const source = analysisOverride ?? currentSupply;
      if (!source) throw new Error('供餐指标尚未计算完成');
      const now = new Date().toISOString();
      const run: SupplyRun = {
        runId: `SUP-${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        createdAt: now,
        note,
        // 深拷贝快照：保存后当前计算再变化也不影响已保存运行
        analysis: JSON.parse(JSON.stringify(source)) as SupplyAnalysis,
      };
      await idbSaveSupplyRun(run);
      setSupplyRuns(await getAllSupplyRuns());
      return run;
    },
    [currentSupply],
  );

  const removeSupplyRun = useCallback(async (runId: string) => {
    await idbDeleteSupplyRun(runId);
    setSupplyRuns(await getAllSupplyRuns());
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
      dismissConflict: () => setConflict(null),
      supplyFilters,
      setSupplyFilters,
      supplyAllergen,
      setSupplyAllergen,
      comparisonScheme,
      supplyActivation,
      supplyStale,
      currentSupply,
      activateLateBatch,
      applyRemoteActivation,
      dismissSupplyStale,
      supplyRuns,
      saveSupplyRun: saveSupplyRunAction,
      removeSupplyRun,
    }),
    [
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
      supplyFilters,
      supplyAllergen,
      comparisonScheme,
      supplyActivation,
      supplyStale,
      currentSupply,
      activateLateBatch,
      applyRemoteActivation,
      dismissSupplyStale,
      supplyRuns,
      saveSupplyRunAction,
      removeSupplyRun,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export class MappingSaveConflictError extends Error {
  remoteRevision: number;
  constructor(remoteRevision: number) {
    super(`映射版本冲突：检测到更新的修订版本 r${remoteRevision}，请重载后再编辑`);
    this.name = 'MappingSaveConflictError';
    this.remoteRevision = remoteRevision;
  }
}

export class SupplyActivationConflictError extends Error {
  remoteRevision: number;
  constructor(remoteRevision: number) {
    super(`补传范围冲突：另一标签页已提交更新的补传（r${remoteRevision}），请应用新范围后再试`);
    this.name = 'SupplyActivationConflictError';
    this.remoteRevision = remoteRevision;
  }
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState 必须在 AppStateProvider 内使用');
  return ctx;
}
