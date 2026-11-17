import type { LoadedBatch, MealWindow, RawRow, SourceType, StandardIngredient } from '../types';
import type { Dataset } from '../lib/loadDataset';

/** 分析期共享的只读上下文：来源索引、窗口、标准原料 */
export interface DataContext {
  dataset: Dataset;
  standards: Map<string, StandardIngredient>;
  windows: MealWindow[];
  byType: Record<SourceType, RawRow[]>;
  batchesByType: Record<SourceType, LoadedBatch[]>;
  sessionById: Map<string, RawRow>;
  recipeIds: Set<string>;
  /** 学校 + 菜谱 + 窗口 + 用料日期 -> 厨房用料行（日期维度防止跨天误关联） */
  usageIndex: Map<string, RawRow[]>;
  dietByStudent: Map<string, RawRow>;
}

function emptyByType(): Record<SourceType, RawRow[]> {
  return {
    supplier_items: [],
    recipes: [],
    kitchen_usage: [],
    meal_sessions: [],
    meal_servings: [],
    diet_restrictions: [],
    window_registry: [],
    service_log: [],
    closure_evidence: [],
    window_usage: [],
  };
}

export function buildContext(dataset: Dataset): DataContext {
  const byType = emptyByType();
  const batchesByType = {} as Record<SourceType, LoadedBatch[]>;
  (Object.keys(byType) as SourceType[]).forEach((t) => {
    batchesByType[t] = [];
  });

  for (const batch of dataset.loadedBatches) {
    byType[batch.meta.sourceType].push(...batch.rows);
    batchesByType[batch.meta.sourceType].push(batch);
  }

  const standards = new Map<string, StandardIngredient>();
  dataset.standards.forEach((s) => standards.set(s.stdId, s));

  const sessionById = new Map<string, RawRow>();
  byType.meal_sessions.forEach((r) => {
    const id = r.values.session_id;
    if (id && !sessionById.has(id)) sessionById.set(id, r);
  });

  const recipeIds = new Set<string>();
  byType.recipes.forEach((r) => {
    if (r.values.recipe_id) recipeIds.add(r.values.recipe_id);
  });

  const usageIndex = new Map<string, RawRow[]>();
  byType.kitchen_usage.forEach((r) => {
    const school = batchSchool(dataset, r.batchId);
    const key = `${school}|${r.values.recipe_id}|${r.values.window}|${r.values.usage_date}`;
    const list = usageIndex.get(key) ?? [];
    list.push(r);
    usageIndex.set(key, list);
  });

  const dietByStudent = new Map<string, RawRow>();
  byType.diet_restrictions.forEach((r) => {
    dietByStudent.set(r.values.studentAnonId, r);
  });

  return {
    dataset,
    standards,
    windows: dataset.manifest.mealWindows,
    byType,
    batchesByType,
    sessionById,
    recipeIds,
    usageIndex,
    dietByStudent,
  };
}

export function batchSchool(dataset: Dataset, batchId: string): string {
  const meta = dataset.manifest.batches.find((b) => b.batchId === batchId);
  return meta?.schoolId ?? '*';
}

export function toMinute(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
