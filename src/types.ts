export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

/** 检测数据版本状态：生效中 / 已被补测取代 / 旧数据回填后无法确认 */
export type InspectionVersionStatus = '生效' | '历史' | '回填待核'
/** 纠偏批次状态：生效 / 同轮后到待复核 / 复核驳回 / 写入中断待恢复 */
export type CorrectionBatchStatus = '生效' | '待复核' | '复核驳回' | '写入中断'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
  /** 所属检测数据版本（纠偏批次或历史回填版本） */
  inspectionVersionId?: string
}

/** 检测数据版本：一次轨检车/补测导入就是一个版本 */
export interface InspectionVersion {
  id: string
  segmentId: string
  /** 区段内顺序版本号，每次补测导入递增 */
  version: number
  measuredAt: string
  detector: string
  /** 导入文件摘要，用于版本识别与旧数据回填核对 */
  fileDigest: string | null
  status: InspectionVersionStatus
  source: '轨检车导入' | '补测纠偏' | '历史回填'
  /** 生效的纠偏批次；历史回填版本为空 */
  batchId?: string
  sampleCount: number
  note?: string
}

/** 区段限速版本：与检测版本同批生效 */
export interface SpeedLimitVersion {
  id: string
  segmentId: string
  version: number
  speedLimit: number
  temporarySpeedLimit?: number
  effectiveAt: string
  source: '历史回填' | '补测纠偏' | '人工调整'
  batchId?: string
  note?: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  /** 当前限速版本号 */
  version: number
  measurements: GeometryMeasurement[]
  inspectionVersions: InspectionVersion[]
  speedLimitVersions: SpeedLimitVersion[]
  /** 当前生效的纠偏批次 */
  activeBatchId?: string
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

/** 里程迁移记录：缺陷随纠偏批次重新定位的轨迹 */
export interface MileageMove {
  fromMileage: number
  toMileage: number
  batchId: string
  movedAt: string
  reason: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
  /** 结论是否仍有效；里程纠偏后旧位置复测结论失效并附重算结论 */
  valid: boolean
  invalidatedByBatchId?: string
  /** 纠偏后就近采样重算的结论 */
  recomputed?: {
    passed: boolean
    measuredValue: number
    sampleMileage: number
    note: string
  }
}

/** 已关闭缺陷在关闭时点的依据快照，里程纠偏不覆盖 */
export interface ClosedBasis {
  mileage: number
  inspectionVersionId: string
  speedLimitVersionId: string
  closedAt: string
  retestSnapshot: RetestResult[]
  note: string
  /** 关闭后经过的纠偏批次（即待复议项来源） */
  reviewBatchIds: string[]
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  version: number
  /** 关联检测版本（按测量时间+文件摘要回填，或随纠偏批次重挂） */
  inspectionVersionId?: string
  /** 旧数据无法确认检测版本时先待核 */
  inspectionVersionUnverified?: boolean
  mileageHistory: MileageMove[]
  /** 已关闭缺陷保留关闭当时依据 */
  closedBasis?: ClosedBasis
  /** 最近一次重新定位/复议的纠偏批次 */
  lastBatchId?: string
}

/** 纠偏批次对单个缺陷的处置结果 */
export interface BatchDefectOutcome {
  defectId: string
  /** 未关闭且无复测：立即重新定位；未关闭且有复测：复测失效重算；已关闭：列入复议 */
  kind: '重定位' | '复测失效重算' | '复议项'
  oldMileage: number
  newMileage: number
  retestRecompute?: Array<{
    round: number
    oldPassed: boolean
    repass: boolean
    measuredValue: number
    limit: number
    sampleMileage: number
  }>
  reviewReason?: string
}

/** 纠偏批次完整载荷，写入失败后据此恢复 */
export interface StoredCorrectionPayload {
  correctedMeasurements: GeometryMeasurement[]
  /** 纠偏前原始区段边界，复议项/重试重算时用于锚点映射 */
  originalStartMileage: number
  originalEndMileage: number
  startMileage: number
  endMileage: number
  anchorStartDelta: number
  anchorEndDelta: number
  speedLimit: number
  temporarySpeedLimit?: number
  inspectionVersion: number
  speedVersion: number
}

export interface CorrectionBatch {
  id: string
  segmentId: string
  /** 同一导入轮次（双窗口同时导入共享），先到生效、后到待复核 */
  roundKey: string
  windowName: string
  operator: string
  importedAt: string
  effectiveAt?: string
  fileDigest: string
  status: CorrectionBatchStatus
  note: string
  inspectionVersionId: string
  speedLimitVersionId: string
  anchorStartDelta: number
  anchorEndDelta: number
  outcomes: BatchDefectOutcome[]
  /** 待复核/中断批次保留完整检测批次，用于复核生效或失败恢复 */
  payload: StoredCorrectionPayload
  /** 保留原始导入输入，复核生效时按当时区段状态重建载荷 */
  input: CorrectionInputShape
  reviewedBy?: string
  reviewedAt?: string
  reviewNote?: string
}

/** 纠偏导入输入（与 CorrectionInput 同形，避免类型文件依赖领域层） */
export interface CorrectionInputShape {
  segmentId: string
  roundKey: string
  windowName: string
  operator: string
  importedAt: string
  fileDigest: string
  note: string
  anchorStartDelta: number
  anchorEndDelta: number
  speedLimit: number
  temporarySpeedLimit?: number
}

/** 分阶段写入恢复日志：记录每个写入键是否落地 */
export interface RecoveryJournal {
  id: string
  batchId: string
  segmentId: string
  roundKey: string
  status: '写入中断' | '已恢复'
  writeKeys: string[]
  landedKeys: string[]
  lastError: string
  /** 故障注入键，首次失败后解除，重试不再中断 */
  failAfterKey: string | null
  createdAt: string
  updatedAt: string
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 同一纠偏批次的审计条目与页面/里程图/导出一致 */
  batchId?: string
}
