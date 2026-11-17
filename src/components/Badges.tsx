import type { ReactNode } from 'react';
import type { EvidenceBucket, FieldStatus, MatchKind } from '../types';
import { BUCKET_LABEL } from '../lib/export';
import { FIELD_STATUS_LABEL } from '../lib/schema';

const BUCKET_CLASS: Record<EvidenceBucket, string> = {
  CONFIRMED: 'confirmed',
  CANDIDATE_PENDING: 'candidate',
  UNKNOWN_MISSING: 'unknown',
};

export function BucketBadge({ bucket }: { bucket: EvidenceBucket }) {
  return <span className={`badge ${BUCKET_CLASS[bucket]}`}>{BUCKET_LABEL[bucket]}</span>;
}

export const MATCH_KIND_LABEL: Record<MatchKind, string> = {
  EXACT_CODE: '精确编码',
  APPROVED_ALIAS: '已批准别名',
  CONFIRMED: '人工确认',
  CANDIDATE: '待确认候选',
  UNMATCHED: '无候选/未知',
};

const MATCH_CLASS: Record<MatchKind, string> = {
  EXACT_CODE: 'ok',
  APPROVED_ALIAS: 'ok',
  CONFIRMED: 'ok',
  CANDIDATE: 'candidate',
  UNMATCHED: 'issue',
};

export function MatchBadge({ kind }: { kind: MatchKind }) {
  return <span className={`badge ${MATCH_CLASS[kind]}`}>{MATCH_KIND_LABEL[kind]}</span>;
}

const FIELD_CLASS: Record<FieldStatus, string> = {
  OK: 'ok',
  FIELD_NOT_PROVIDED: 'issue',
  VALUE_EMPTY: 'candidate',
  REF_NOT_FOUND: 'issue',
  BATCH_PENDING: 'neutral',
};

export function FieldStatusBadge({ status }: { status: FieldStatus }) {
  return <span className={`badge ${FIELD_CLASS[status]}`}>{FIELD_STATUS_LABEL[status]}</span>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'issue' | 'candidate'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
