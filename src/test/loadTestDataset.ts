import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { sha256 } from '../lib/hash';
import type { LoadedBatch, Manifest, MappingDocument, RawRow, StandardIngredient } from '../types';
import type { Dataset } from '../lib/loadDataset';

const ROOT = join(__dirname, '..', '..', 'public', 'sample-data');

function text(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

function flattenDiet(json: { restrictions: Array<Record<string, unknown>> }, batchId: string): RawRow[] {
  return json.restrictions.map((r, i) => {
    const avoid = Array.isArray(r.avoidAllergens) ? (r.avoidAllergens as string[]).join(';') : '';
    return {
      rowId: `${batchId}#L${i + 1}`,
      batchId,
      lineNo: i + 1,
      values: {
        studentAnonId: String(r.studentAnonId ?? ''),
        schoolId: String(r.schoolId ?? ''),
        avoidAllergens: avoid,
        note: String(r.note ?? ''),
        effectiveFrom: r.effectiveFrom == null ? '' : String(r.effectiveFrom),
        effectiveTo: r.effectiveTo == null ? '' : String(r.effectTo),
      },
    };
  });
}

/** 测试用 Dataset 构建：与 src/lib/loadDataset.ts 的浏览器逻辑保持一致 */
export async function loadTestDataset(): Promise<Dataset> {
  const manifest: Manifest = JSON.parse(text('manifest.json'));
  const standards: StandardIngredient[] = JSON.parse(text('standard_ingredients.json'));
  const seedMapping: MappingDocument = JSON.parse(text('seed_mappings.json'));

  const loadedBatches: LoadedBatch[] = [];
  const rowsByBatch: Record<string, RawRow[]> = {};
  const hashes: Record<string, string> = {};
  const pendingBatches: LoadedBatch[] = [];
  const pendingHashes: Record<string, string> = {};
  let dietRows: RawRow[] = [];

  for (const meta of manifest.batches) {
    rowsByBatch[meta.batchId] = [];
    if (meta.status === 'PENDING') {
      try {
        const raw = text(meta.fileName);
        pendingHashes[meta.batchId] = await sha256(raw);
        const { headers, rows } = parseCsv(raw, meta.batchId);
        pendingBatches.push({ meta, headers, rows, fileHash: pendingHashes[meta.batchId] });
      } catch {
        // 文件未上传：保持未到齐
      }
      continue;
    }
    const raw = text(meta.fileName);
    hashes[meta.batchId] = await sha256(raw);
    if (meta.sourceType === 'diet_restrictions') {
      dietRows = flattenDiet(JSON.parse(raw), meta.batchId);
      rowsByBatch[meta.batchId] = dietRows;
      loadedBatches.push({
        meta,
        headers: ['studentAnonId', 'schoolId', 'avoidAllergens', 'note', 'effectiveFrom', 'effectiveTo'],
        rows: dietRows,
        fileHash: hashes[meta.batchId],
      });
    } else {
      const { headers, rows } = parseCsv(raw, meta.batchId);
      rowsByBatch[meta.batchId] = rows;
      loadedBatches.push({ meta, headers, rows, fileHash: hashes[meta.batchId] });
    }
  }

  const metaHashes = {
    manifest: await sha256(text('manifest.json')),
    standard_ingredients: await sha256(text('standard_ingredients.json')),
    seed_mappings: await sha256(text('seed_mappings.json')),
  };

  return { manifest, standards, seedMapping, loadedBatches, rowsByBatch, dietRows, hashes, metaHashes, pendingBatches, pendingHashes };
}

export function listSampleFiles(): string[] {
  return readdirSync(ROOT, { recursive: true }) as string[];
}
