import type {
  LoadedBatch,
  Manifest,
  MappingDocument,
  RawRow,
  StandardIngredient,
} from '../types';
import { parseCsv } from './csv';
import { sha256 } from './hash';

export const DATA_BASE = '/sample-data';

export interface Dataset {
  manifest: Manifest;
  standards: StandardIngredient[];
  seedMapping: MappingDocument;
  loadedBatches: LoadedBatch[];
  /** batchId -> 原始行（PENDING 批次为空数组） */
  rowsByBatch: Record<string, RawRow[]>;
  /** 饮食限制 JSON 展开后的统一行结构 */
  dietRows: RawRow[];
  /** batchId -> 文件哈希；PENDING 批次无哈希 */
  hashes: Record<string, string>;
  /** 清单文件与参考数据自身的哈希，运行口径一并固定 */
  metaHashes: Record<string, string>;
  /** 未到齐批次的内容（仅供补传预览/激活使用，不进入既有引擎） */
  pendingBatches: LoadedBatch[];
  /** PENDING 批次文件哈希 */
  pendingHashes: Record<string, string>;
}

async function fetchText(path: string): Promise<string> {
  const resp = await fetch(`${DATA_BASE}/${path}`);
  if (!resp.ok) throw new Error(`无法加载样例文件 ${path}: HTTP ${resp.status}`);
  return resp.text();
}

/** 把饮食限制 JSON 展开成与 CSV 一致的 RawRow，字段检查可统一处理 */
function flattenDiet(json: { restrictions: Array<Record<string, unknown>> }, batchId: string): RawRow[] {
  return json.restrictions.map((r, i) => {
    const avoid = Array.isArray(r.avoidAllergens) ? (r.avoidAllergens as string[]).join(';') : '';
    const values: Record<string, string> = {
      studentAnonId: String(r.studentAnonId ?? ''),
      schoolId: String(r.schoolId ?? ''),
      avoidAllergens: avoid,
      note: String(r.note ?? ''),
      effectiveFrom: r.effectiveFrom == null ? '' : String(r.effectiveFrom),
      effectiveTo: r.effectiveTo == null ? '' : String(r.effectiveTo),
    };
    return { rowId: `${batchId}#L${i + 1}`, batchId, lineNo: i + 1, values };
  });
}

export async function loadDataset(): Promise<Dataset> {
  const manifestText = await fetchText('manifest.json');
  const manifest: Manifest = JSON.parse(manifestText);
  const standards: StandardIngredient[] = JSON.parse(await fetchText('standard_ingredients.json'));
  const seedMapping: MappingDocument = JSON.parse(await fetchText('seed_mappings.json'));

  const loadedBatches: LoadedBatch[] = [];
  const rowsByBatch: Record<string, RawRow[]> = {};
  const hashes: Record<string, string> = {};
  const pendingBatches: LoadedBatch[] = [];
  const pendingHashes: Record<string, string> = {};
  let dietRows: RawRow[] = [];

  for (const meta of manifest.batches) {
    rowsByBatch[meta.batchId] = [];
    if (meta.status === 'PENDING') {
      // 未到齐批次：内容单独加载，仅供“补传预览/激活”使用，不进入既有分析与哈希口径
      try {
        const text = await fetchText(meta.fileName);
        const fileHash = await sha256(text);
        pendingHashes[meta.batchId] = fileHash;
        const { headers, rows } = parseCsv(text, meta.batchId);
        pendingBatches.push({ meta, headers, rows, fileHash });
      } catch {
        // 文件确实未上传：保持“未到齐”状态，预览时提示无内容
      }
      continue;
    }

    const text = await fetchText(meta.fileName);
    const fileHash = await sha256(text);
    hashes[meta.batchId] = fileHash;

    if (meta.sourceType === 'diet_restrictions') {
      const json = JSON.parse(text) as { restrictions: Array<Record<string, unknown>> };
      dietRows = flattenDiet(json, meta.batchId);
      const headers = ['studentAnonId', 'schoolId', 'avoidAllergens', 'note', 'effectiveFrom', 'effectiveTo'];
      rowsByBatch[meta.batchId] = dietRows;
      loadedBatches.push({ meta, headers, rows: dietRows, fileHash });
    } else {
      const { headers, rows } = parseCsv(text, meta.batchId);
      rowsByBatch[meta.batchId] = rows;
      loadedBatches.push({ meta, headers, rows, fileHash });
    }
  }

  const metaHashes = {
    manifest: await sha256(manifestText),
    standard_ingredients: await sha256(await fetchText('standard_ingredients.json')),
    seed_mappings: await sha256(await fetchText('seed_mappings.json')),
  };

  return { manifest, standards, seedMapping, loadedBatches, rowsByBatch, dietRows, hashes, metaHashes, pendingBatches, pendingHashes };
}
