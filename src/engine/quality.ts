import type {
  FieldCheck,
  FieldStatus,
  LoadedBatch,
  QualityIssue,
  QualityIssueType,
  RawRow,
} from '../types';
import { SOURCE_SCHEMAS, isSupplySource } from '../lib/schema';
import { normalizeUnit } from './rules';
import { batchSchool, toMinute, type DataContext } from './context';

interface DupGroup {
  key: string;
  rows: RawRow[];
}

function duplicateGroups(rows: RawRow[], fields: string[]): DupGroup[] {
  const groups = new Map<string, RawRow[]>();
  rows.forEach((r) => {
    const key = fields.map((f) => r.values[f] ?? '').join('|');
    if (fields.some((f) => !(r.values[f] ?? '').trim())) return; // 空键交给缺失检查
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  });
  return Array.from(groups.entries())
    .filter(([, list]) => list.length > 1)
    .map(([key, rows]) => ({ key, rows }));
}

function missingKeyRows(rows: RawRow[], fields: string[]): RawRow[] {
  return rows.filter((r) => fields.some((f) => !(r.values[f] ?? '').trim()));
}

/** 五类质量检查，全部基于输入行生成，可下钻到原始行 */
export function runQualityChecks(ctx: DataContext): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const ds = ctx.dataset;

  for (const batch of ds.loadedBatches) {
    // 供餐指标来源（窗口登记/发餐日志/停业依据/窗口用料）由供餐引擎独立核对，
    // 其重复行按“供餐记录去重”处理，不进入领餐级五类质量检查
    if (isSupplySource(batch.meta.sourceType)) continue;
    const schema = SOURCE_SCHEMAS[batch.meta.sourceType];

    // 1. 重复键
    for (const g of duplicateGroups(batch.rows, schema.keyFields)) {
      issues.push({
        type: 'DUPLICATE_KEY',
        batchId: batch.meta.batchId,
        rowIds: g.rows.map((r) => r.rowId),
        field: schema.keyFields.join('+'),
        message: `主键 ${schema.keyFields.join('+')}=${g.key} 出现 ${g.rows.length} 次`,
        detail: { key: g.key, occurrences: g.rows.length },
      });
    }

    // 2. 缺失键
    for (const r of missingKeyRows(batch.rows, schema.keyFields)) {
      issues.push({
        type: 'MISSING_KEY',
        batchId: batch.meta.batchId,
        rowIds: [r.rowId],
        field: schema.keyFields.join('+'),
        message: `第 ${r.lineNo} 行主键字段缺失（${schema.keyFields.join('+')}）`,
      });
    }

    // 3. 单位冲突：同一来源内同一商品/简称出现互不一致的计量单位
    if (batch.meta.sourceType === 'supplier_items' || batch.meta.sourceType === 'kitchen_usage') {
      const unitField = batch.meta.sourceType === 'supplier_items' ? 'unit' : 'unit';
      const nameField = batch.meta.sourceType === 'supplier_items' ? 'supplier_code' : 'kitchen_alias';
      const units = new Map<string, { unit: string; rows: RawRow[] }[]>();
      batch.rows.forEach((r) => {
        const name = r.values[nameField];
        const unit = normalizeUnit(r.values[unitField] ?? '');
        if (!name || !unit) return;
        const list = units.get(name) ?? [];
        const hit = list.find((x) => x.unit === unit);
        if (hit) hit.rows.push(r);
        else list.push({ unit, rows: [r] });
        units.set(name, list);
      });
      units.forEach((variants, name) => {
        if (variants.length > 1) {
          issues.push({
            type: 'UNIT_CONFLICT',
            batchId: batch.meta.batchId,
            rowIds: variants.flatMap((v) => v.rows.map((r) => r.rowId)),
            field: unitField,
            message: `${nameField}=${name} 同时出现单位 ${variants.map((v) => v.unit).join(' / ')}`,
            detail: { name, units: variants.map((v) => v.unit).join('|') },
          });
        }
      });
    }

    // 4. 时间无法归属：窗口不在约定内，或起止时间不落在该窗口
    if (batch.meta.sourceType === 'meal_sessions') {
      for (const r of batch.rows) {
        const windowName = r.values.window;
        const school = r.values.school_id || batchSchool(ds, r.batchId);
        const win = ctx.windows.find(
          (w) => (w.schoolId === '*' || w.schoolId === school) && w.window === windowName,
        );
        if (!win) {
          issues.push({
            type: 'TIME_UNASSIGNABLE',
            batchId: batch.meta.batchId,
            rowIds: [r.rowId],
            field: 'window',
            message: `餐次 ${r.values.session_id} 的窗口「${windowName}」不在约定窗口内`,
          });
          continue;
        }
        const start = toMinute(r.values.start_time);
        const end = toMinute(r.values.end_time);
        const wStart = toMinute(win.start);
        const wEnd = toMinute(win.end);
        if (
          start === null ||
          end === null ||
          wStart === null ||
          wEnd === null ||
          start < wStart ||
          end > wEnd
        ) {
          issues.push({
            type: 'TIME_UNASSIGNABLE',
            batchId: batch.meta.batchId,
            rowIds: [r.rowId],
            field: 'start_time',
            message: `餐次 ${r.values.session_id} 时间 ${r.values.start_time}-${r.values.end_time} 不落在 ${windowName} 窗口 ${win.start}-${win.end}`,
          });
        }
      }
    }
  }

  // 关联对象不存在（跨来源）
  pushRefNotFoundIssues(ctx, issues);

  // 5. 多对多连接：同一原料键对应多个标准原料，或同一标准原料被多个候选键竞争
  pushManyToManyIssues(ctx, issues);

  return issues;
}

function pushRefNotFoundIssues(ctx: DataContext, issues: QualityIssue[]): void {
  // 餐次引用的菜谱不存在
  ctx.byType.meal_sessions.forEach((r) => {
    const recipeId = r.values.recipe_id;
    if (recipeId && !ctx.recipeIds.has(recipeId)) {
      issues.push({
        type: 'MISSING_KEY',
        batchId: r.batchId,
        rowIds: [r.rowId],
        field: 'recipe_id',
        message: `餐次 ${r.values.session_id} 引用的菜谱 ${recipeId} 在菜谱来源中不存在`,
        detail: { ref: recipeId },
      });
    }
  });

  // 领餐引用的餐次不存在
  ctx.byType.meal_servings.forEach((r) => {
    const sid = r.values.session_id;
    if (!sid) {
      issues.push({
        type: 'MISSING_KEY',
        batchId: r.batchId,
        rowIds: [r.rowId],
        field: 'session_id',
        message: `领餐 ${r.values.serving_id} 未填写餐次`,
      });
    } else if (!ctx.sessionById.has(sid)) {
      issues.push({
        type: 'MISSING_KEY',
        batchId: r.batchId,
        rowIds: [r.rowId],
        field: 'session_id',
        message: `领餐 ${r.values.serving_id} 引用的餐次 ${sid} 不存在`,
        detail: { ref: sid },
      });
    }
  });
}

function pushManyToManyIssues(ctx: DataContext, issues: QualityIssue[]): void {
  // 供应商编码复用：同一编码在同校出现成分不一致的多条商品记录
  const byCode = new Map<string, RawRow[]>();
  ctx.byType.supplier_items.forEach((r) => {
    const code = r.values.supplier_code;
    if (!code) return;
    const school = batchSchool(ctx.dataset, r.batchId);
    const key = `${school}|${code}`;
    const list = byCode.get(key) ?? [];
    list.push(r);
    byCode.set(key, list);
  });
  byCode.forEach((rows, key) => {
    const allergenSets = new Set(rows.map((r) => r.values.allergens_declared ?? ''));
    const names = new Set(rows.map((r) => r.values.product_name ?? ''));
    if (allergenSets.size > 1 || names.size > 1) {
      const [school, code] = key.split('|');
      issues.push({
        type: 'MANY_TO_MANY',
        batchId: rows[0].batchId,
        rowIds: rows.map((r) => r.rowId),
        field: 'supplier_code',
        message: `编码复用：${school}校供应商编码 ${code} 对应 ${names.size} 个商品名 / ${allergenSets.size} 套过敏原声明`,
        detail: { school, code },
      });
    }
  });

  // 厨房简称跨批次映射到多个标准原料（由当前映射文档判断，运行时传入的 ctx 中已含解析结果时使用）
  const aliasTargets = new Map<string, Set<string>>();
  ctx.byType.kitchen_usage.forEach((r) => {
    const alias = r.values.kitchen_alias;
    if (!alias) return;
    const school = batchSchool(ctx.dataset, r.batchId);
    const std = (r as RawRow & { __resolvedStdId?: string }).__resolvedStdId;
    if (!std) return;
    const key = `${school}|${alias}`;
    const set = aliasTargets.get(key) ?? new Set<string>();
    set.add(std);
    aliasTargets.set(key, set);
  });
  aliasTargets.forEach((set, key) => {
    if (set.size > 1) {
      const [school, alias] = key.split('|');
      issues.push({
        type: 'MANY_TO_MANY',
        batchId: '',
        rowIds: [],
        field: 'kitchen_alias',
        message: `厨房简称「${alias}」在 ${school}校被映射到多个标准原料：${Array.from(set).join('、')}`,
        detail: { school, alias },
      });
    }
  });
}

/**
 * 字段四态检查，严格区分：
 * FIELD_NOT_PROVIDED 源文件未提供该列 / VALUE_EMPTY 列为空 /
 * REF_NOT_FOUND 关联对象不存在 / BATCH_PENDING 批次未到齐
 */
export function runFieldChecks(ctx: DataContext): FieldCheck[] {
  const checks: FieldCheck[] = [];
  const ds = ctx.dataset;

  for (const meta of ds.manifest.batches) {
    if (isSupplySource(meta.sourceType)) continue; // 供餐来源的字段核对由供餐引擎负责
    const schema = SOURCE_SCHEMAS[meta.sourceType];
    if (meta.status === 'PENDING') {
      schema.expectedFields.forEach((field) => {
        checks.push({ batchId: meta.batchId, field, status: 'BATCH_PENDING', count: meta.expectedRows, rowIds: [] });
      });
      continue;
    }
    const batch: LoadedBatch | undefined = ds.loadedBatches.find((b) => b.meta.batchId === meta.batchId);
    if (!batch) continue;

    for (const field of schema.expectedFields) {
      if (!batch.headers.includes(field)) {
        checks.push({ batchId: meta.batchId, field, status: 'FIELD_NOT_PROVIDED', count: batch.rows.length, rowIds: [] });
        continue;
      }
      const emptyRows = batch.rows.filter((r) => !(r.values[field] ?? '').trim());
      if (emptyRows.length > 0) {
        checks.push({
          batchId: meta.batchId,
          field,
          status: 'VALUE_EMPTY',
          count: emptyRows.length,
          rowIds: emptyRows.map((r) => r.rowId),
        });
      }
    }
  }

  // 关联对象不存在单独统计
  collectRefNotFoundFieldChecks(ctx, checks);
  return checks;
}

function collectRefNotFoundFieldChecks(ctx: DataContext, checks: FieldCheck[]): void {
  const missingSession: RawRow[] = [];
  ctx.byType.meal_servings.forEach((r) => {
    const sid = r.values.session_id;
    if (sid && !ctx.sessionById.has(sid)) missingSession.push(r);
  });
  if (missingSession.length > 0) {
    checks.push({
      batchId: missingSession[0].batchId,
      field: 'session_id->meal_sessions',
      status: 'REF_NOT_FOUND',
      count: missingSession.length,
      rowIds: missingSession.map((r) => r.rowId),
    });
  }

  const missingRecipe: RawRow[] = [];
  ctx.byType.meal_sessions.forEach((r) => {
    if (r.values.recipe_id && !ctx.recipeIds.has(r.values.recipe_id)) missingRecipe.push(r);
  });
  if (missingRecipe.length > 0) {
    checks.push({
      batchId: missingRecipe[0].batchId,
      field: 'recipe_id->recipes',
      status: 'REF_NOT_FOUND',
      count: missingRecipe.length,
      rowIds: missingRecipe.map((r) => r.rowId),
    });
  }

  // 饮食限制登记了但样例期内没有任何领餐（关联对象=领餐记录不存在）
  const servedStudents = new Set(ctx.byType.meal_servings.map((r) => r.values.student_anon_id).filter(Boolean));
  const noServing: RawRow[] = [];
  ctx.byType.diet_restrictions.forEach((r) => {
    if (!servedStudents.has(r.values.studentAnonId)) noServing.push(r);
  });
  if (noServing.length > 0) {
    checks.push({
      batchId: noServing[0].batchId,
      field: 'studentAnonId->meal_servings',
      status: 'REF_NOT_FOUND',
      count: noServing.length,
      rowIds: noServing.map((r) => r.rowId),
    });
  }
}

export const QUALITY_LABEL: Record<QualityIssueType, string> = {
  DUPLICATE_KEY: '重复键',
  MISSING_KEY: '缺失键/关联缺失',
  UNIT_CONFLICT: '单位冲突',
  TIME_UNASSIGNABLE: '时间无法归属',
  MANY_TO_MANY: '多对多连接',
};

export const FIELD_STATUS_ORDER: FieldStatus[] = [
  'FIELD_NOT_PROVIDED',
  'VALUE_EMPTY',
  'REF_NOT_FOUND',
  'BATCH_PENDING',
];

export function qualityIssueCounts(issues: QualityIssue[]): Record<QualityIssueType, number> {
  const init: Record<QualityIssueType, number> = {
    DUPLICATE_KEY: 0,
    MISSING_KEY: 0,
    UNIT_CONFLICT: 0,
    TIME_UNASSIGNABLE: 0,
    MANY_TO_MANY: 0,
  };
  issues.forEach((i) => {
    init[i.type] += 1;
  });
  return init;
}
