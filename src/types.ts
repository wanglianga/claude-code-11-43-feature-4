// 领域类型定义：所有分析结果均由输入数据 + 映射 + 规则版本派生

export type SourceType =
  | 'supplier_items'
  | 'recipes'
  | 'kitchen_usage'
  | 'meal_sessions'
  | 'meal_servings'
  | 'diet_restrictions'
  | 'window_registry'
  | 'service_log'
  | 'closure_evidence'
  | 'window_usage';

export type BatchStatus = 'ARRIVED' | 'PENDING';

/** 来源声明的完成范围：该批次承诺覆盖的学校/窗口/餐别/日期区间 */
export interface DeclaredScope {
  schoolId: string;
  /** '*' 表示该校全部窗口 */
  serviceWindow: string;
  /** '*' 表示全部餐别 */
  mealTypes: string[] | '*';
  dateFrom: string;
  dateTo: string;
}

export interface BatchMeta {
  batchId: string;
  sourceType: SourceType;
  schoolId: string;
  fileName: string;
  dataDate: string;
  updatedAt: string | null;
  expectedRows: number;
  status: BatchStatus;
  notes?: string;
  /** 来源登记：各来源声明的完成范围（供餐指标口径用） */
  declaredScope?: DeclaredScope[];
}

export interface Manifest {
  manifestVersion: string;
  generatedAt: string;
  mealWindows: MealWindow[];
  batches: BatchMeta[];
}

export interface MealWindow {
  schoolId: string;
  window: string;
  start: string;
  end: string;
}

/** 解析后的原始行：保留行号与原始字段，便于下钻 */
export interface RawRow {
  rowId: string; // batchId + '#' + 行号
  batchId: string;
  lineNo: number;
  values: Record<string, string>;
}

export interface LoadedBatch {
  meta: BatchMeta;
  headers: string[];
  rows: RawRow[];
  /** 输入文件内容哈希（运行固定引用，防止静默改写） */
  fileHash: string;
}

export interface StandardIngredient {
  stdId: string;
  name: string;
  category: string;
  allergens: string[];
  baseUnit: string;
}

export type MappingDecision = 'APPROVED_ALIAS' | 'CONFIRMED' | 'REJECTED' | 'CANDIDATE';

export interface SupplierMappingEntry {
  schoolId: string;
  supplierCode: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface KitchenMappingEntry {
  schoolId: string;
  kitchenAlias: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface StudentSessionMappingEntry {
  studentAnonId: string;
  sessionId: string;
  decision: MappingDecision;
  note?: string;
}

export interface MappingDocument {
  mappingVersion: string;
  ruleVersion: string;
  updatedAt: string;
  supplierMappings: SupplierMappingEntry[];
  kitchenMappings: KitchenMappingEntry[];
  studentSessionMappings: StudentSessionMappingEntry[];
}

/** 映射保存时的乐观锁包装 */
export interface MappingState {
  doc: MappingDocument;
  /** 单调递增版本号，保存冲突检测用 */
  revision: number;
  lastModifiedAt: string;
}

// ---------- 质量检查 ----------

export type QualityIssueType =
  | 'DUPLICATE_KEY'
  | 'MISSING_KEY'
  | 'UNIT_CONFLICT'
  | 'TIME_UNASSIGNABLE'
  | 'MANY_TO_MANY';

export interface QualityIssue {
  type: QualityIssueType;
  batchId: string;
  rowIds: string[];
  field: string;
  message: string;
  detail?: Record<string, string | number>;
}

/** 字段四态：源文件未提供 / 值为空 / 关联对象不存在 / 批次未到齐 */
export type FieldStatus =
  | 'FIELD_NOT_PROVIDED'
  | 'VALUE_EMPTY'
  | 'REF_NOT_FOUND'
  | 'BATCH_PENDING'
  | 'OK';

export interface FieldCheck {
  batchId: string;
  field: string;
  status: FieldStatus;
  count: number;
  rowIds: string[];
}

// ---------- 匹配与候选 ----------

export type MatchKind = 'EXACT_CODE' | 'APPROVED_ALIAS' | 'CONFIRMED' | 'CANDIDATE' | 'UNMATCHED';

export interface MatchCandidate {
  target: string; // 被匹配的键（供应商编码 / 厨房简称）
  stdId: string;
  score: number;
  reasons: string[];
}

export interface MatchResolution {
  scope: string; // schoolId 或 *
  sourceKey: string;
  kind: MatchKind;
  stdId: string | null;
  candidates: MatchCandidate[];
  evidenceRowIds: string[];
}

// ---------- 分析运行 ----------

export type EvidenceBucket = 'CONFIRMED' | 'CANDIDATE_PENDING' | 'UNKNOWN_MISSING';

export interface ServingAssessment {
  servingId: string;
  studentAnonId: string;
  sessionId: string;
  schoolId: string;
  servedAt: string;
  window: string;
  recipeId: string;
  bucket: EvidenceBucket;
  /** 实际参与计算的厨房用料行（仅 ACTUAL 且已解析到标准原料） */
  usageRowIds: string[];
  allergensConfirmed: string[];
  restrictionAllergens: string[];
  exposedConfirmed: string[];
  unknownReasons: string[];
  trace: TraceStep[];
}

export interface TraceStep {
  stage: string;
  decision: string;
  ref: string;
}

export interface CoverageCounts {
  total: number;
  confirmed: number;
  candidatePending: number;
  unknownMissing: number;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  inputHashes: Record<string, string>;
  mappingVersion: string;
  mappingRevision: number;
  ruleVersion: string;
  scopeBatchIds: string[];
  coverage: CoverageCounts;
  confirmedExposures: number;
  confirmedSafe: number;
  unknownReasonsBreakdown: Record<string, number>;
  qualityIssueCounts: Record<QualityIssueType, number>;
}

export interface AnalysisRun {
  summary: RunSummary;
  assessments: ServingAssessment[];
  qualityIssues: QualityIssue[];
  fieldChecks: FieldCheck[];
  resolutions: MatchResolution[];
  metricDetails: MetricDetail[];
}

export interface MetricDetail {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  exclusions: string[];
  sourceScope: string[];
  explanation: string;
}

export interface RunDiff {
  baseRunId: string;
  targetRunId: string;
  changedServingBuckets: Record<EvidenceBucket, Record<EvidenceBucket, number>>;
  coverageBefore: CoverageCounts;
  coverageAfter: CoverageCounts;
  changedServingIds: string[];
  newIssues: QualityIssue[];
  resolvedIssues: QualityIssue[];
}

// ---------- 跨校供餐指标（统计单位：学校+窗口+业务日+餐别 定位的一次供餐记录） ----------

/** 供餐指标筛选范围：任何筛选变化都会重新核对总体、分子、分母与参照适用性 */
export interface SupplyFilters {
  schools: string[];
  mealTypes: string[];
  dateFrom: string;
  dateTo: string;
}

/** 供餐记录状态：实际供餐 / 明确停业 / 明确零供餐 / 未解释缺口 */
export type SupplyRecordStatus = 'ACTUAL' | 'CLOSED' | 'ZERO_SERVED' | 'GAP';

/** 针对选定成分，单次供餐记录的判断结果 */
export type ComponentVerdict = 'CONTAINS' | 'NOT_FOUND' | 'UNKNOWN';

export interface UsageEvidenceRow {
  rowId: string;
  alias: string;
  stdId: string | null;
  stdName: string | null;
  reason: string;
}

/** 一条供餐记录对选定成分的判断（每种成分各自按供餐记录计算，不跨成分相加） */
export interface ComponentJudgment {
  allergen: string;
  verdict: ComponentVerdict;
  /** 有实际用料依据且解析到含该成分的标准原料 */
  positiveRows: UsageEvidenceRow[];
  /** 已解析且不含该成分的实际用料行 */
  negativeRows: UsageEvidenceRow[];
  /** 无法解析/候选未确认/名称为空的实际用料行 */
  unknownRows: UsageEvidenceRow[];
  /** 计划使用行数（不计入任何判断） */
  plannedExcluded: number;
  reasons: string[];
}

/** 一条供餐记录及其纳入/排除/去重轨迹 */
export interface SupplyRecordEval {
  key: string; // school|window|date|mealType
  schoolId: string;
  serviceWindow: string;
  bizDate: string;
  mealType: string;
  status: SupplyRecordStatus;
  /** 开放时间分段（同一窗口同餐别多段开放属于同一记录） */
  segments: Array<{ start: string; end: string }>;
  /** 发餐份数仅作实际供餐证据展示，不作指标分母 */
  servings: number | null;
  logRowIds: string[];
  plannedLogRowIds: string[];
  closureRowIds: string[];
  registryRowIds: string[];
  /** 去重信息：重复上报/多对多连接不能复制供餐记录 */
  dedup: {
    rawLogRows: number;
    duplicatesRemoved: number;
    registryOverlap: boolean;
  };
  inclusionReason: string;
  /** 仅 ACTUAL 记录有成分判断 */
  judgment: ComponentJudgment | null;
}

/** 餐别分层统计 */
export interface StratumStats {
  mealType: string;
  expected: number;
  actual: number;
  closedZero: number;
  gaps: number;
  verified: number; // contains + notFound
  contains: number;
  notFound: number;
  unknown: number;
  /** 已核实记录中的比例：只覆盖已核实子集 */
  verifiedRatio: number | null;
  /** 边界：未知记录不同取值下的下界/上界（分母=已知实际供餐数），非置信区间 */
  lowerBound: number | null;
  upperBound: number | null;
}

/** 一所学校的总体核对结果 */
export interface SchoolReconciliation {
  expected: number;
  actual: number;
  closedZero: number;
  gaps: number;
  /** 总体是否已完整：无未解释缺口 */
  complete: boolean;
  gapKeys: string[];
  closedZeroKeys: string[];
}

export interface SchoolIndicator {
  schoolId: string;
  reconciliation: SchoolReconciliation;
  strata: StratumStats[];
  totals: {
    actual: number;
    verified: number;
    contains: number;
    notFound: number;
    unknown: number;
  };
  /** 已核实子集合计比例（只覆盖已核实子集，不是全校完整比例） */
  verifiedRatioMerged: number | null;
  /** 总体已完整时给出：下界=已确认含有/实际供餐总量，上界计入尚不能判定的记录 */
  bounds: { lower: number; upper: number } | null;
  boundsBlockedReason: string | null;
}

/** 比较方案：维护餐别分层、参照构成和排除范围；切换学校不改变参照 */
export interface ComparisonScheme {
  schemeId: string;
  schemeVersion: string;
  name: string;
  /** 固定参照餐别权重（直接标准化用），按比较范围归一化时显式展示 */
  weights: Record<string, number>;
  exclusionNote: string;
  note: string;
}

export interface StratumContribution {
  mealType: string;
  weight: number;
  verifiedRatio: number | null;
  contains: number;
  verified: number;
  actual: number;
  unknown: number;
  gaps: number;
  /** 该层对调整值的贡献 = weight × verifiedRatio；无样本层为 null */
  contribution: number | null;
  /** 层内存在未解释缺口：已核实比例可能不代表整层 */
  gapFlag: boolean;
}

export interface AdjustedResult {
  schoolId: string;
  /** 参照各层均有可核实资料时才能完成该校的完整调整值 */
  complete: boolean;
  incompleteReasons: string[];
  contributions: StratumContribution[];
  adjusted: number | null;
  /** 调整边界：未知记录取不同值时的下界/上界；重叠时不强行给出高低结论 */
  interval: { lower: number; upper: number } | null;
}

export interface ComparisonResult {
  scheme: ComparisonScheme;
  mealTypes: string[];
  /** 按当前比较范围归一化后的参照权重（显式展示，不静默改变） */
  effectiveWeights: Record<string, number>;
  schools: AdjustedResult[];
  /** 双方均有可核实资料的餐别层（可比范围） */
  comparableStrata: string[];
  incomparableStrata: Array<{ mealType: string; missingSchools: string[] }>;
  canConclude: boolean;
  conclusion: string;
}

/** 一次完整供餐指标计算：图表与导出引用同一次计算 */
export interface SupplyAnalysis {
  allergen: string;
  filters: SupplyFilters;
  activatedLateBatches: string[];
  scheme: ComparisonScheme;
  generatedAt: string;
  inputHashes: Record<string, string>;
  mappingVersion: string;
  mappingRevision: number;
  ruleVersion: string;
  records: SupplyRecordEval[];
  schools: SchoolIndicator[];
  comparison: ComparisonResult;
}

/** 供餐指标运行：不可变快照，保存当时的资料覆盖与参照 */
export interface SupplyRun {
  runId: string;
  createdAt: string;
  note?: string;
  analysis: SupplyAnalysis;
}

/** 补传预览：先展示分母/未知/可比范围差异，再生成新运行 */
export interface LateBatchPreview {
  candidateBatchId: string;
  denominatorBefore: number;
  denominatorAfter: number;
  unknownBefore: number;
  unknownAfter: number;
  containsBefore: number;
  containsAfter: number;
  gapsBefore: number;
  gapsAfter: number;
  transitions: Array<{
    key: string;
    label: string;
    beforeStatus: SupplyRecordStatus;
    afterStatus: SupplyRecordStatus;
    beforeVerdict: ComponentVerdict | null;
    afterVerdict: ComponentVerdict | null;
    /** 新增分母=缺口转为实际供餐；分母不变=已有记录的判断变化，不重复新增供餐记录 */
    denominatorEffect: '新增分母' | '分母不变';
  }>;
  comparableBefore: string[];
  comparableAfter: string[];
  adjustedBefore: Array<{ schoolId: string; adjusted: number | null }>;
  adjustedAfter: Array<{ schoolId: string; adjusted: number | null }>;
}
