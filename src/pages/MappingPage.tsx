import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { MatchBadge } from '../components/Badges';
import { CoverageBar } from '../components/Coverage';
import { previewImpact, type ImpactPreview } from '../engine/runEngine';
import { MappingSaveConflictError } from '../state/AppState';
import type {
  KitchenMappingEntry,
  MappingDocument,
  MatchResolution,
  StudentSessionMappingEntry,
  SupplierMappingEntry,
} from '../types';

type TabKey = 'supplier' | 'kitchen' | 'student';

export function MappingPage() {
  const { dataset, mappingState, currentRun, saveMapping, createRun } = useAppState();
  const [tab, setTab] = useState<TabKey>('supplier');
  const [draft, setDraft] = useState<MappingDocument | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (mappingState) {
      setDraft(structuredClone(mappingState.doc));
      setBaseRevision(mappingState.revision);
      setPreview(null);
    }
  }, [mappingState]);

  const dirty = useMemo(() => {
    if (!draft || !mappingState) return false;
    return JSON.stringify(draft) !== JSON.stringify(mappingState.doc);
  }, [draft, mappingState]);

  const studentLinks = useMemo(() => {
    if (!dataset || !mappingState) return [];
    const rows = dataset.rowsByBatch['meal-2'] ?? [];
    const map = new Map<string, StudentSessionMappingEntry>();
    mappingState.doc.studentSessionMappings.forEach((m) => map.set(`${m.studentAnonId}|${m.sessionId}`, m));
    const seen = new Set<string>();
    const links: Array<{ student: string; session: string; decision?: StudentSessionMappingEntry['decision']; school: string }> = [];
    rows.forEach((r) => {
      const key = `${r.values.student_anon_id}|${r.values.session_id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const m = map.get(key);
      const session = dataset.rowsByBatch['meal-1']?.find((s) => s.values.session_id === r.values.session_id);
      links.push({
        student: r.values.student_anon_id,
        session: r.values.session_id,
        decision: m?.decision,
        school: session?.values.school_id ?? '?',
      });
    });
    return links;
  }, [dataset, mappingState]);

  if (!dataset || !mappingState || !currentRun || !draft) return null;

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const upsertSupplier = (schoolId: string, supplierCode: string, stdId: string, decision: SupplierMappingEntry['decision'], note?: string) => {
    setDraft((d) => {
      if (!d) return d;
      const rest = d.supplierMappings.filter((m) => !(m.schoolId === schoolId && m.supplierCode === supplierCode));
      return { ...d, supplierMappings: [...rest, { schoolId, supplierCode, stdId, decision, note }] };
    });
    setPreview(null);
  };

  const upsertKitchen = (schoolId: string, kitchenAlias: string, stdId: string, decision: KitchenMappingEntry['decision'], note?: string) => {
    setDraft((d) => {
      if (!d) return d;
      const rest = d.kitchenMappings.filter((m) => !(m.schoolId === schoolId && m.kitchenAlias === kitchenAlias));
      return { ...d, kitchenMappings: [...rest, { schoolId, kitchenAlias, stdId, decision, note }] };
    });
    setPreview(null);
  };

  const upsertStudent = (studentAnonId: string, sessionId: string, decision: StudentSessionMappingEntry['decision']) => {
    setDraft((d) => {
      if (!d) return d;
      const rest = d.studentSessionMappings.filter(
        (m) => !(m.studentAnonId === studentAnonId && m.sessionId === sessionId),
      );
      return { ...d, studentSessionMappings: [...rest, { studentAnonId, sessionId, decision }] };
    });
    setPreview(null);
  };

  const doPreview = () => {
    setPreview(previewImpact(dataset, mappingState.doc, draft, baseRevision));
  };

  const doSave = async (andRun: boolean) => {
    try {
      await saveMapping(draft, baseRevision);
      flash(andRun ? '映射已保存，正在生成新运行…' : '映射已保存（修订版本已递增）');
      if (andRun) {
        const run = await createRun();
        flash(`已保存并生成新运行 ${run.summary.runId}`);
      }
      setPreview(null);
    } catch (err) {
      if (err instanceof MappingSaveConflictError) {
        flash('保存被拒绝：检测到另一标签页的更新版本，请按顶部横幅重载');
      } else {
        flash(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const supplierRes = currentRun.resolutions.filter((r) => r.scope.startsWith('supplier:'));
  const kitchenRes = currentRun.resolutions.filter((r) => r.scope.startsWith('kitchen:'));

  return (
    <div>
      <h1 className="page-title">映射工作台</h1>
      <p className="page-desc">
        精确供应商编码与已批准别名自动进入统计；名称/规格/单位/成分生成的候选必须由分析师确认后才生效，
        未确认候选不会进入正式结果。所有修改先预览影响行，再决定保存；保存时校验修订版本，后提交者不会覆盖已确认映射。
      </p>

      <div className={`banner ${dirty ? 'warn' : 'info'}`}>
        基线版本：{mappingState.doc.mappingVersion} <b>r{baseRevision}</b>
        {dirty ? '　·　存在未保存修改（候选确认前不会影响任何正式结果）' : '　·　与已保存版本一致'}
        <span style={{ marginLeft: 12 }}>
          供应商映射 {draft.supplierMappings.length} 条 · 厨房映射 {draft.kitchenMappings.length} 条 · 学号餐次 {draft.studentSessionMappings.length} 条
        </span>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'supplier' ? 'active' : ''}`} onClick={() => setTab('supplier')}>
          供应商货号 → 标准原料（{supplierRes.length}）
        </button>
        <button className={`tab ${tab === 'kitchen' ? 'active' : ''}`} onClick={() => setTab('kitchen')}>
          菜谱/厨房简称 → 实际用料（{kitchenRes.length}）
        </button>
        <button className={`tab ${tab === 'student' ? 'active' : ''}`} onClick={() => setTab('student')}>
          匿名学号 → 餐次记录（{studentLinks.length}）
        </button>
      </div>

      <div className="filter-bar">
        <input
          placeholder="筛选键/范围/标准原料…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 260 }}
        />
        <button className="btn" onClick={doPreview} disabled={!dirty}>预览影响</button>
        <button className="btn primary" onClick={() => void doSave(false)} disabled={!dirty}>保存映射</button>
        <button className="btn primary" onClick={() => void doSave(true)} disabled={!dirty}>保存并生成新运行</button>
        <button className="btn danger" onClick={() => { setDraft(structuredClone(mappingState.doc)); setPreview(null); }} disabled={!dirty}>
          放弃修改
        </button>
      </div>

      {tab === 'supplier' && (
        <ResolutionTable
          resolutions={supplierRes}
          filter={filter}
          stdName={(id) => dataset.standards.find((s) => s.stdId === id)?.name ?? id}
          renderActions={(r) => {
            const [, school] = r.scope.split(':');
            const current = draft.supplierMappings.find((m) => m.schoolId === school && m.supplierCode === r.sourceKey);
            return (
              <CandidateActions
                resolution={r}
                currentStdId={current?.stdId ?? r.stdId ?? undefined}
                standards={dataset.standards}
                onConfirm={(stdId, note) => upsertSupplier(school, r.sourceKey, stdId, 'CONFIRMED', note)}
                onApprove={(stdId) => upsertSupplier(school, r.sourceKey, stdId, 'APPROVED_ALIAS')}
                onReject={() => upsertSupplier(school, r.sourceKey, current?.stdId ?? r.candidates[0]?.stdId ?? 'SI001', 'REJECTED')}
              />
            );
          }}
        />
      )}

      {tab === 'kitchen' && (
        <ResolutionTable
          resolutions={kitchenRes}
          filter={filter}
          stdName={(id) => dataset.standards.find((s) => s.stdId === id)?.name ?? id}
          renderActions={(r) => {
            const [, school] = r.scope.split(':');
            const current = draft.kitchenMappings.find((m) => m.schoolId === school && m.kitchenAlias === r.sourceKey);
            return (
              <CandidateActions
                resolution={r}
                currentStdId={current?.stdId ?? r.stdId ?? undefined}
                standards={dataset.standards}
                onConfirm={(stdId, note) => upsertKitchen(school, r.sourceKey, stdId, 'CONFIRMED', note)}
                onApprove={(stdId) => upsertKitchen(school, r.sourceKey, stdId, 'APPROVED_ALIAS')}
                onReject={() => upsertKitchen(school, r.sourceKey, current?.stdId ?? r.candidates[0]?.stdId ?? 'SI001', 'REJECTED')}
              />
            );
          }}
        />
      )}

      {tab === 'student' && (
        <div className="card">
          <table className="data">
            <thead>
              <tr><th>匿名学号</th><th>学校</th><th>餐次</th><th>饮食限制</th><th>当前决定</th><th>操作</th></tr>
            </thead>
            <tbody>
              {studentLinks
                .filter((l) => `${l.student} ${l.session} ${l.school}`.includes(filter))
                .map((l) => {
                  const diet = dataset.dietRows.find((d) => d.values.studentAnonId === l.student);
                  return (
                    <tr key={`${l.student}|${l.session}`}>
                      <td className="mono">{l.student}</td>
                      <td>{l.school}</td>
                      <td className="mono">{l.session || <span className="muted">（餐次为空）</span>}</td>
                      <td>{diet?.values.avoidAllergens || <span className="muted">无登记/禁忌为空</span>}</td>
                      <td>{l.decision ? <MatchBadge kind={l.decision === 'CANDIDATE' ? 'CANDIDATE' : 'APPROVED_ALIAS'} /> : <span className="muted">未映射</span>}</td>
                      <td>
                        <button className="btn small" disabled={!l.session} onClick={() => upsertStudent(l.student, l.session, 'APPROVED_ALIAS')}>
                          确认对应
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="card">
          <h2>影响预览（未保存，未确认候选仍不进入正式结果）</h2>
          <div className="grid cols-2">
            <div>
              <h3>变更前覆盖</h3>
              <CoverageBar coverage={preview.coverageBefore} />
            </div>
            <div>
              <h3>变更后覆盖（预览口径）</h3>
              <CoverageBar coverage={preview.coverageAfter} />
            </div>
          </div>
          <h3>受影响的解析键（{preview.changedResolutionKeys.length}）</h3>
          <ul className="mono" style={{ fontSize: 12 }}>
            {preview.changedResolutionKeys.slice(0, 20).map((k) => <li key={k}>{k}</li>)}
          </ul>
          <h3>领餐记录桶位变化（{preview.servingBucketChanges.length}）</h3>
          {preview.servingBucketChanges.length === 0 ? (
            <p className="muted">本次修改暂未改变任何领餐记录的证据桶。</p>
          ) : (
            <table className="data">
              <thead><tr><th>领餐</th><th>变更前</th><th></th><th>变更后</th></tr></thead>
              <tbody>
                {preview.servingBucketChanges.map((c) => (
                  <tr key={c.servingId}>
                    <td className="mono">{c.servingId}</td>
                    <td>{c.before}</td>
                    <td>→</td>
                    <td><b>{c.after}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ResolutionTable({
  resolutions,
  filter,
  stdName,
  renderActions,
}: {
  resolutions: MatchResolution[];
  filter: string;
  stdName: (id: string) => string;
  renderActions: (r: MatchResolution) => React.ReactNode;
}) {
  const filtered = resolutions.filter(
    (r) =>
      `${r.scope} ${r.sourceKey} ${r.stdId ?? ''} ${r.candidates.map((c) => c.stdId).join(' ')}`.includes(filter),
  );
  return (
    <div className="card">
      <table className="data">
        <thead>
          <tr>
            <th>范围</th>
            <th>来源键</th>
            <th>当前解析</th>
            <th>候选（评分 / 依据）</th>
            <th style={{ width: 300 }}>人工操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={`${r.scope}|${r.sourceKey}`}>
              <td className="mono muted" style={{ fontSize: 12 }}>{r.scope}</td>
              <td className="mono">{r.sourceKey}
                <div className="muted" style={{ fontSize: 11 }}>证据行 {r.evidenceRowIds.length} 条</div>
              </td>
              <td>
                <MatchBadge kind={r.kind} />
                {r.stdId && (
                  <div style={{ marginTop: 4 }}>
                    {r.stdId} · {stdName(r.stdId)}
                  </div>
                )}
              </td>
              <td>
                {r.candidates.length === 0 ? (
                  <span className="muted">无候选</span>
                ) : (
                  r.candidates.map((c) => (
                    <div key={c.stdId} className="candidate-card">
                      <span className="score">{c.score} 分</span>
                      {c.stdId} · {stdName(c.stdId)}
                      <div className="muted" style={{ fontSize: 11 }}>{c.reasons.join('；')}</div>
                    </div>
                  ))
                )}
              </td>
              <td>{renderActions(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateActions({
  resolution,
  currentStdId,
  standards,
  onConfirm,
  onApprove,
  onReject,
}: {
  resolution: MatchResolution;
  currentStdId?: string;
  standards: { stdId: string; name: string; allergens: string[] }[];
  onConfirm: (stdId: string, note?: string) => void;
  onApprove: (stdId: string) => void;
  onReject: () => void;
}) {
  const [chosen, setChosen] = useState(currentStdId ?? resolution.candidates[0]?.stdId ?? standards[0].stdId);
  useEffect(() => {
    setChosen(currentStdId ?? resolution.candidates[0]?.stdId ?? standards[0].stdId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution.scope, resolution.sourceKey]);

  return (
    <div className="pill-group">
      <select value={chosen} onChange={(e) => setChosen(e.target.value)} style={{ maxWidth: 150 }}>
        {standards.map((s) => (
          <option key={s.stdId} value={s.stdId}>
            {s.stdId} {s.name}{s.allergens.length ? `（${s.allergens.join('/')}）` : ''}
          </option>
        ))}
      </select>
      <button className="btn small primary" onClick={() => onConfirm(chosen, '分析师在映射工作台确认候选')}>
        确认候选
      </button>
      <button className="btn small" onClick={() => onApprove(chosen)}>批准为别名</button>
      <button
        className="btn small danger"
        disabled={!currentStdId && resolution.candidates.length === 0}
        title={!currentStdId && resolution.candidates.length === 0 ? '尚无候选或已有决定，无法否决' : ''}
        onClick={onReject}
      >
        否决
      </button>
    </div>
  );
}
