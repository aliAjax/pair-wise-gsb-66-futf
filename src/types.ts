export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

/** 纠偏批次生命周期：待复核（同窗口后到）→ 生效；或写入失败 → 重试后生效；或作废 */
export type BatchStatus = '待复核' | '生效' | '写入失败' | '作废'
/** 检测版本确认度：回填时按测量时间与文件摘要匹配，匹配不上的先待核 */
export type VersionConfidence = '已确认' | '待核'
/** 已关闭缺陷的复议项状态 */
export type ReviewStatus = '待复议' | '维持关闭' | '重新立项' | '随批次作废'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
  /** 所属检测数据版本（纠偏批次回填或旧数据迁移回填） */
  inspectionVersionId?: string
}

export interface SpeedLimitVersion {
  version: number
  speedLimit: number
  temporarySpeedLimit?: number
  /** 限速版本绑定的纠偏批次；手工限速调整时为空 */
  batchId?: string
  changedAt: string
  note: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  /** 区段限速版本号（版本递增计数器），与限速版本历史的最新版本一致 */
  version: number
  measurements: GeometryMeasurement[]
  /** 当前生效的纠偏批次 */
  activeBatchId?: string
  /** 区段限速版本历史 */
  speedLimitHistory: SpeedLimitVersion[]
}

export interface InspectionVersion {
  id: string
  segmentId: string
  /** 测量批次时间（采样点的最早测量时间） */
  measuredAt: string
  /** 导入时间 */
  importedAt: string
  /** 检测文件摘要（内容哈希），同一文件重复导入可识别 */
  fileDigest: string
  /** 采样点 id 列表 */
  measurementIds: string[]
  /** 由哪个纠偏批次生效；旧数据回填时为空 */
  batchId?: string
  confidence: VersionConfidence
  note: string
}

export interface MileageAdjustment {
  /** 旧里程 */
  from: number
  /** 纠偏后里程 */
  to: number
  /** 该里程整体平移量（米） */
  delta: number
  batchId: string
  at: string
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
  /** 失效原因：里程纠偏后，旧复测结论基于旧里程，失效重算 */
  invalidatedAt?: string
  invalidatedByBatchId?: string
  invalidReason?: string
}

export interface MileageHistoryEntry {
  from: number
  to: number
  delta: number
  batchId: string
  at: string
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
  /** 缺陷定位绑定的检测数据版本 */
  inspectionVersionId?: string
  /** 检测版本确认度，待核缺陷需在页面显式标注 */
  versionConfidence: VersionConfidence
  /** 里程变更轨迹（纠偏批次只追加，不覆盖） */
  mileageHistory: MileageHistoryEntry[]
  /** 已关闭缺陷保留的当时依据 */
  closedBasis?: {
    mileage: number
    retestRound: number
    measuredValue: number
    limit: number
    tester: string
    testedAt: string
    closedAt: string
    inspectionVersionId?: string
    batchId?: string
    note: string
  }
}

export interface ReconsiderationItem {
  id: string
  defectId: string
  segmentId: string
  /** 关闭时里程 */
  closedMileage: number
  /** 纠偏后的新里程 */
  newMileage: number
  delta: number
  batchId: string
  raisedAt: string
  status: ReviewStatus
  /** 复议结论与处理人 */
  resolvedAt?: string
  resolvedBy?: string
  resolutionNote?: string
}

export interface DefectPlanEntry {
  defectId: string
  from: number
  to: number
  delta: number
  open: boolean
}

/** 纠偏批次的完整落地计划（原子执行单元），写入失败后凭此从完整批次恢复 */
export interface BatchPlan {
  /** 全部操作键（有序），重试时已落地键直接跳过 */
  allOps: string[]
  /** 纠偏后区段起止里程 */
  rangeStart: number
  rangeEnd: number
  /** 待写入的检测数据版本（无新增采样时为 null） */
  inspectionVersion: InspectionVersion | null
  measurements: GeometryMeasurement[]
  defects: DefectPlanEntry[]
  /** 已关闭缺陷生成的复议项（待写入） */
  reconsiderations: ReconsiderationItem[]
  /** 待写入的限速版本（每个生效批次都生成一个限速版本，无调整则值不变） */
  speedVersion: SpeedLimitVersion
  audits: Array<Omit<AuditEntry, 'id'>>
}

export interface CorrectionPayload {
  segmentId: string
  measuredAt: string
  detector: string
  /** 补测文件摘要（可留空，按修正结果内容生成） */
  fileDigest?: string
  /** 纠偏窗口标识（同区段同日为同一导入窗口） */
  windowKey: string
  /** 纠偏后区段起止里程，缺省沿用旧值 */
  startMileage?: number
  endMileage?: number
  /** 里程整体平移量（米），用于全部采样点和未关闭缺陷重定位 */
  offset: number
  /** 修正后的检测采样点（缺省时按旧采样点整体平移生成） */
  measurements?: GeometryMeasurement[]
  /** 限速版本一并接入纠偏批次；缺省沿用当前限速 */
  speedLimit?: number
  temporarySpeedLimit?: undefined | number
  note: string
}

export interface CorrectionBatch {
  id: string
  segmentId: string
  /** 导入窗口（区段 + 补测日期），同窗口后到内容待复核 */
  windowKey: string
  status: BatchStatus
  fileDigest: string
  measuredAt: string
  importedAt: string
  /** 完整检测批次内容，恢复重试只依赖它 */
  payload: CorrectionPayload
  /** 预先生成的落地计划 */
  plan: BatchPlan
  /** 已落地对象键（幂等标记），重试只处理未落地对象 */
  landedOps: string[]
  failedOp?: string
  failureReason?: string
  /** 被后到复核或失败重试时引用的前一个生效批次 */
  supersededBatchId?: string
  decidedAt?: string
  decidedBy?: string
  note?: string
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 审计统一挂接纠偏批次，页面/导出按批次聚合 */
  batchId?: string
}

/** localStorage 持久化结构（schemaVersion=2 为纠偏批次模型） */
export interface TrackState {
  schemaVersion: 2
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
  inspectionVersions: InspectionVersion[]
  batches: CorrectionBatch[]
  reconsiderations: ReconsiderationItem[]
}
