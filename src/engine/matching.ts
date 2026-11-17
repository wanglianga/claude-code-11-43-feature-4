import type {
  KitchenMappingEntry,
  MappingDocument,
  MatchCandidate,
  MatchResolution,
  RawRow,
  SupplierMappingEntry,
} from '../types';
import { batchSchool, type DataContext } from './context';
import { CANDIDATE_THRESHOLD, MAX_CANDIDATES, nameSimilarity, normalizeUnit } from './rules';

export interface ResolvedStd {
  kind: MatchResolution['kind'];
  stdId: string | null;
  reasons: string[];
}

/** 字符重叠兜底分：处理“鲜虾/基围虾”这类无 bigram 交集但共享关键字的中文名 */
function charOverlapScore(a: string, b: string): number {
  const sa = new Set(a);
  const common = [...b].filter((c) => sa.has(c)).length;
  if (common === 0) return 0;
  return Math.round((common / Math.min(a.length, b.length)) * 55);
}

function buildCandidates(name: string, unit: string | undefined, ctx: DataContext): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  ctx.standards.forEach((std) => {
    const nameScore = nameSimilarity(name, std.name);
    const charScore = charOverlapScore(name, std.name);
    let score = Math.max(nameScore, charScore);
    const reasons: string[] = [];
    if (nameScore >= CANDIDATE_THRESHOLD) reasons.push(`名称相似度 ${nameScore}`);
    else if (charScore >= CANDIDATE_THRESHOLD) reasons.push(`关键字重合 ${charScore}`);
    if (unit && normalizeUnit(unit) === std.baseUnit) {
      score = Math.min(100, score + 5);
      reasons.push(`单位一致(${std.baseUnit})`);
    }
    if (std.allergens.length > 0 && std.allergens.some((al) => name.includes(al.slice(0, 1)))) {
      score = Math.min(100, score + 5);
      reasons.push(`名称含过敏原提示字`);
    }
    if (score >= CANDIDATE_THRESHOLD) {
      candidates.push({ target: name, stdId: std.stdId, score, reasons });
    }
  });
  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

export function buildSupplierResolutions(
  ctx: DataContext,
  mapping: MappingDocument,
): MatchResolution[] {
  const out: MatchResolution[] = [];
  // 同校同编码的全部行（识别编码复用）
  const codeRows = new Map<string, RawRow[]>();
  ctx.byType.supplier_items.forEach((r) => {
    const code = r.values.supplier_code;
    if (!code) return;
    const school = batchSchool(ctx.dataset, r.batchId);
    const key = `${school}|${code}`;
    const list = codeRows.get(key) ?? [];
    list.push(r);
    codeRows.set(key, list);
  });

  const mapIndex = new Map<string, SupplierMappingEntry>();
  mapping.supplierMappings.forEach((m) => mapIndex.set(`${m.schoolId}|${m.supplierCode}`, m));

  codeRows.forEach((rows, key) => {
    const [school, code] = key.split('|');
    const first = rows[0];
    const evidenceRowIds = rows.map((r) => r.rowId);
    const m = mapIndex.get(key);
    const reused =
      new Set(rows.map((r) => r.values.product_name)).size > 1 ||
      new Set(rows.map((r) => r.values.allergens_declared)).size > 1;

    const candidates = buildCandidates(first.values.product_name ?? '', first.values.unit, ctx);

    if (m && (m.decision === 'APPROVED_ALIAS' || m.decision === 'CONFIRMED') && !reused) {
      out.push({
        scope: `supplier:${school}`,
        sourceKey: code,
        kind: m.decision === 'APPROVED_ALIAS' ? 'APPROVED_ALIAS' : 'CONFIRMED',
        stdId: m.stdId,
        candidates: [],
        evidenceRowIds,
      });
    } else if (m && m.decision === 'CANDIDATE') {
      out.push({
        scope: `supplier:${school}`,
        sourceKey: code,
        kind: 'CANDIDATE',
        stdId: null,
        candidates: candidates.some((c) => c.stdId === m.stdId)
          ? candidates
          : [{ target: code, stdId: m.stdId, score: 50, reasons: ['映射文档中保存的待确认决定'] }, ...candidates],
        evidenceRowIds,
      });
    } else {
      // 无映射、被否决或编码复用：候选需人工确认；编码复用在原因中显式标注
      if (reused) {
        candidates.forEach((c) => c.reasons.unshift('编码复用：同编码存在不同配方，必须人工确认'));
      }
      if (m?.decision === 'REJECTED') {
        candidates.forEach((c) => c.reasons.unshift('此前映射已被否决'));
      }
      out.push({
        scope: `supplier:${school}`,
        sourceKey: code,
        kind: candidates.length > 0 ? 'CANDIDATE' : 'UNMATCHED',
        stdId: null,
        candidates,
        evidenceRowIds,
      });
    }
  });
  return out;
}

export function buildKitchenResolutions(
  ctx: DataContext,
  mapping: MappingDocument,
): MatchResolution[] {
  const out: MatchResolution[] = [];
  const aliasRows = new Map<string, { rows: RawRow[]; unit?: string }>();
  ctx.byType.kitchen_usage.forEach((r) => {
    const alias = r.values.kitchen_alias;
    if (!alias) return;
    const school = batchSchool(ctx.dataset, r.batchId);
    const key = `${school}|${alias}`;
    const slot = aliasRows.get(key) ?? { rows: [], unit: r.values.unit };
    slot.rows.push(r);
    aliasRows.set(key, slot);
    // 附带解析结果，供多对多质量检查使用
    (r as RawRow & { __resolvedStdId?: string }).__resolvedStdId = undefined;
  });

  const mapIndex = new Map<string, KitchenMappingEntry>();
  mapping.kitchenMappings.forEach((m) => mapIndex.set(`${m.schoolId}|${m.kitchenAlias}`, m));

  const resolver = new Map<string, ResolvedStd>();

  aliasRows.forEach((slot, key) => {
    const [school, alias] = key.split('|');
    const m = mapIndex.get(key);
    const candidates = buildCandidates(alias, slot.unit, ctx);
    const evidenceRowIds = slot.rows.map((r) => r.rowId);

    let resolution: MatchResolution;
    if (m && (m.decision === 'APPROVED_ALIAS' || m.decision === 'CONFIRMED')) {
      resolution = {
        scope: `kitchen:${school}`,
        sourceKey: alias,
        kind: m.decision === 'APPROVED_ALIAS' ? 'APPROVED_ALIAS' : 'CONFIRMED',
        stdId: m.stdId,
        candidates: [],
        evidenceRowIds,
      };
      resolver.set(key, {
        kind: resolution.kind,
        stdId: m.stdId,
        reasons: [m.note ?? '已批准别名/人工确认'],
      });
      slot.rows.forEach((r) => {
        (r as RawRow & { __resolvedStdId?: string }).__resolvedStdId = m.stdId;
      });
    } else if (m?.decision === 'CANDIDATE') {
      resolution = {
        scope: `kitchen:${school}`,
        sourceKey: alias,
        kind: 'CANDIDATE',
        stdId: null,
        candidates: [{ target: alias, stdId: m.stdId, score: 50, reasons: ['映射文档中保存的待确认决定'] }, ...candidates].slice(0, MAX_CANDIDATES + 1),
        evidenceRowIds,
      };
      resolver.set(key, { kind: 'CANDIDATE', stdId: null, reasons: ['存在候选但尚未确认'] });
    } else {
      resolution = {
        scope: `kitchen:${school}`,
        sourceKey: alias,
        kind: candidates.length > 0 ? 'CANDIDATE' : 'UNMATCHED',
        stdId: null,
        candidates,
        evidenceRowIds,
      };
      resolver.set(key, {
        kind: resolution.kind,
        stdId: null,
        reasons: candidates.length > 0 ? ['存在候选但尚未确认'] : ['无候选：来源缺失无法判定'],
      });
    }
    out.push(resolution);
  });

  // 暴露给覆盖分析使用
  kitchenResolverStorage.resolver = resolver;
  return out;
}

/** 模块级解析器句柄：runEngine 每次运行重建，避免跨运行污染 */
export const kitchenResolverStorage: { resolver: Map<string, ResolvedStd> } = {
  resolver: new Map(),
};

export function resolveKitchen(school: string, alias: string): ResolvedStd | undefined {
  return kitchenResolverStorage.resolver.get(`${school}|${alias}`);
}

/** 菜谱标准配料 → 标准原料的候选解析（用于菜谱映射页与计划/实际对照） */
export function buildRecipeResolutions(ctx: DataContext): MatchResolution[] {
  const out: MatchResolution[] = [];
  const nameRows = new Map<string, RawRow[]>();
  ctx.byType.recipes.forEach((r) => {
    const name = r.values.ingredient_name;
    if (!name) return;
    const list = nameRows.get(name) ?? [];
    list.push(r);
    nameRows.set(name, list);
  });

  nameRows.forEach((rows, name) => {
    let foundStdId: string | null = null;
    ctx.standards.forEach((std) => {
      if (std.name === name) foundStdId = std.stdId;
    });
    const candidates = buildCandidates(name, rows[0].values.unit, ctx);
    if (foundStdId) {
      out.push({
        scope: 'recipe',
        sourceKey: name,
        kind: 'EXACT_CODE',
        stdId: foundStdId,
        candidates: [],
        evidenceRowIds: rows.map((r) => r.rowId),
      });
    } else {
      out.push({
        scope: 'recipe',
        sourceKey: name,
        kind: candidates.length > 0 ? 'CANDIDATE' : 'UNMATCHED',
        stdId: null,
        candidates,
        evidenceRowIds: rows.map((r) => r.rowId),
      });
    }
  });
  return out;
}
