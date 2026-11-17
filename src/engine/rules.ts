// 规则版本：任何口径调整都必须提升版本号，运行结果固定引用，旧运行不被静默改写
export const RULE_VERSION = 'rules-v1';

/** 名称归一化：去空白/括号备注/常见品类后缀，便于中文名称相似度比较 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s　]/g, '')
    .trim();
}

function bigrams(s: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

/** Sørensen–Dice bigram 相似度，0~100 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  if (y.includes(x) || x.includes(y)) {
    // 短词被长词包含（如“虾”∈“基围虾”）给予较高基础分
    return Math.max(60, 70 + Math.min(x.length, y.length) * 2);
  }
  const gx = bigrams(x);
  const gy = bigrams(y);
  let inter = 0;
  gx.forEach((g) => {
    if (gy.has(g)) inter++;
  });
  if (gx.size + gy.size === 0) return 0;
  return Math.round((2 * inter * 100) / (gx.size + gy.size));
}

/** 单位归一化：升/毫升、千克/克 等 */
export function normalizeUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  const map: Record<string, string> = {
    升: 'L',
    毫升: 'mL',
    kg: 'kg',
    千克: 'kg',
    g: 'g',
    克: 'g',
  };
  return map[u] ?? u;
}

/** 候选评分阈值与返回条数 */
export const CANDIDATE_THRESHOLD = 45;
export const MAX_CANDIDATES = 3;
