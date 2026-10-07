import type {
  AuditEntry, BatchDefectOutcome, CorrectionBatch, Defect, DefectType,
  GeometryMeasurement, InspectionVersion, SpeedLimitVersion, StoredCorrectionPayload, TrackSegment
} from '../types'

/** 一次补测纠偏导入的输入（窗口 = 导入终端/作业窗口） */
export interface CorrectionInput {
  segmentId: string
  /** 同一导入轮次，双窗口同时导入时共享 */
  roundKey: string
  windowName: string
  operator: string
  importedAt: string
  fileDigest: string
  note: string
  /** 起点/终点锚点里程修正量（米，负=里程缩短） */
  anchorStartDelta: number
  anchorEndDelta: number
  speedLimit: number
  temporarySpeedLimit?: number
}

export interface AuditDraft {
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export interface WriteStep {
  key: string
  audit?: AuditDraft
}

export interface PreparedApplication {
  inspectionVersion: InspectionVersion
  speedVersion: SpeedLimitVersion
  outcomes: BatchDefectOutcome[]
  writeKeys: string[]
  writes: WriteStep[]
}

/** FNV-1a 32位摘要，模拟导入文件摘要（8位十六进制） */
export function digest8(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function sampleDigest(segmentId: string, dateKey: string, points: Array<{ id: string; mileage: number }>): string {
  return digest8(`${segmentId}|${dateKey}|${points.map((point) => `${point.id}@${point.mileage}`).join(',')}`)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 线性锚点纠偏：按里程比例在起点/终点修正量之间插值 */
export function mapMileage(mileage: number, start: number, end: number, deltaStart: number, deltaEnd: number): number {
  const ratio = start === end ? 0 : clamp((mileage - start) / (end - start), 0, 1)
  return Math.round(mileage + deltaStart + (deltaEnd - deltaStart) * ratio)
}

export function metricOf(point: GeometryMeasurement, type: DefectType): number {
  if (type === '轨距') return point.gauge
  if (type === '高低') return point.level
  if (type === '方向') return point.alignment
  return point.twist
}

export function nearestMeasurement(points: GeometryMeasurement[], mileage: number): GeometryMeasurement | undefined {
  return points.reduce<GeometryMeasurement | undefined>((best, point) => {
    if (!best || Math.abs(point.mileage - mileage) < Math.abs(best.mileage - mileage)) return point
    return best
  }, undefined)
}

export function buildCorrectedMeasurements(segment: TrackSegment, input: CorrectionInput): GeometryMeasurement[] {
  return segment.measurements.map((point) => ({
    id: `GM-COR-${input.fileDigest}-${point.id}`,
    mileage: mapMileage(point.mileage, segment.startMileage, segment.endMileage, input.anchorStartDelta, input.anchorEndDelta),
    gauge: point.gauge,
    level: point.level,
    alignment: point.alignment,
    twist: point.twist,
    measuredAt: input.importedAt,
    detector: 'GJ-6型轨检车（补测）'
  }))
}

export function buildPayload(segment: TrackSegment, input: CorrectionInput): StoredCorrectionPayload {
  return {
    correctedMeasurements: buildCorrectedMeasurements(segment, input),
    originalStartMileage: segment.startMileage,
    originalEndMileage: segment.endMileage,
    startMileage: mapMileage(segment.startMileage, segment.startMileage, segment.endMileage, input.anchorStartDelta, input.anchorEndDelta),
    endMileage: mapMileage(segment.endMileage, segment.startMileage, segment.endMileage, input.anchorStartDelta, input.anchorEndDelta),
    anchorStartDelta: input.anchorStartDelta,
    anchorEndDelta: input.anchorEndDelta,
    speedLimit: input.speedLimit,
    temporarySpeedLimit: input.temporarySpeedLimit,
    inspectionVersion: 0,
    speedVersion: 0
  }
}

function buildOutcomes(defects: Defect[], payload: StoredCorrectionPayload): BatchDefectOutcome[] {
  return defects.map((defect) => {
    const newMileage = mapMileage(defect.mileage, payload.originalStartMileage, payload.originalEndMileage, payload.anchorStartDelta, payload.anchorEndDelta)
    const open = defect.status !== '已关闭'
    if (!open) {
      return {
        defectId: defect.id,
        kind: '复议项',
        oldMileage: defect.mileage,
        newMileage,
        reviewReason: `缺陷已于关闭时点定位 K${formatKm(defect.mileage)} 并留档，纠偏后该位置对应 K${formatKm(newMileage)}；关闭依据保留，建议复议后再决定是否重挂新版本`
      }
    }
    const validRetests = defect.retests.filter((item) => item.valid)
    if (!validRetests.length) {
      return { defectId: defect.id, kind: '重定位', oldMileage: defect.mileage, newMileage }
    }
    const nearest = nearestMeasurement(payload.correctedMeasurements, newMileage)
    return {
      defectId: defect.id,
      kind: '复测失效重算',
      oldMileage: defect.mileage,
      newMileage,
      retestRecompute: validRetests.map((retest) => {
        const measuredValue = nearest ? +metricOf(nearest, defect.type).toFixed(2) : retest.measuredValue
        return {
          round: retest.round,
          oldPassed: retest.passed,
          repass: measuredValue <= defect.limit,
          measuredValue,
          limit: defect.limit,
          sampleMileage: nearest?.mileage ?? newMileage
        }
      })
    }
  })
}

export function formatKm(mileage: number): string {
  return `K${Math.floor(mileage / 1000)}+${String(mileage % 1000).padStart(3, '0')}`
}

/**
 * 依据完整检测批次载荷与当前状态准备写入计划。
 * 初次生效、失败重试、待复核生效都走这里；已落地写入键由上层跳过。
 * 恢复时传入 outcomesOverride（首次准备时的快照），避免部分缺陷已重定位导致二次映射。
 */
export function prepareApplication(segment: TrackSegment, defects: Defect[], batch: CorrectionBatch, effectiveAt: string, outcomesOverride?: BatchDefectOutcome[]): PreparedApplication {
  const payload = batch.payload
  const segmentDefects = defects.filter((item) => item.segmentId === segment.id)
  const outcomes = outcomesOverride ?? buildOutcomes(segmentDefects, payload)

  const inspectionVersionNumber = segment.inspectionVersions.reduce((max, item) => Math.max(max, item.version), 0) + 1
  const speedVersionNumber = segment.speedLimitVersions.reduce((max, item) => Math.max(max, item.version), 0) + 1
  const inspectionVersion: InspectionVersion = {
    id: `IV-${batch.id}`,
    segmentId: segment.id,
    version: inspectionVersionNumber,
    measuredAt: batch.importedAt,
    detector: 'GJ-6型轨检车（补测）',
    fileDigest: batch.fileDigest,
    status: '生效',
    source: '补测纠偏',
    batchId: batch.id,
    sampleCount: payload.correctedMeasurements.length,
    note: `${batch.windowName}导入，锚点修正 ${payload.anchorStartDelta}/${payload.anchorEndDelta} m`
  }
  const speedVersion: SpeedLimitVersion = {
    id: `SV-${batch.id}`,
    segmentId: segment.id,
    version: speedVersionNumber,
    speedLimit: payload.speedLimit,
    temporarySpeedLimit: payload.temporarySpeedLimit,
    effectiveAt,
    source: '补测纠偏',
    batchId: batch.id,
    note: `与检测版本 V${inspectionVersionNumber} 同纠偏批次生效`
  }

  const relocateCount = outcomes.filter((item) => item.kind === '重定位').length
  const retestCount = outcomes.filter((item) => item.kind === '复测失效重算').length
  const reviewCount = outcomes.filter((item) => item.kind === '复议项').length
  const operator = `${batch.operator}（${batch.windowName}）`

  const writes: WriteStep[] = [
    {
      key: 'measurements',
      audit: {
        entityId: segment.id,
        action: '导入检测数据（补测纠偏）',
        operator,
        detail: `文件摘要 ${batch.fileDigest}，锚点修正 起点${payload.anchorStartDelta}m / 终点${payload.anchorEndDelta}m，${payload.correctedMeasurements.length}个采样点重新定位；检测版本 V${inspectionVersionNumber} 生效，旧版本转历史`,
        createdAt: effectiveAt
      }
    },
    ...outcomes.map((outcome) => ({
      key: `defect:${outcome.defectId}`,
      audit: auditForOutcome(outcome, operator, effectiveAt, inspectionVersionNumber)
    })),
    {
      key: 'speed',
      audit: {
        entityId: segment.id,
        action: '区段限速版本生效（纠偏批次）',
        operator,
        detail: `限速版本 V${speedVersionNumber}：正式 ${payload.speedLimit} km/h，临时 ${payload.temporarySpeedLimit ?? '无'} km/h，与检测版本 V${inspectionVersionNumber} 同批生效`,
        createdAt: effectiveAt
      }
    },
    {
      key: 'summary',
      audit: {
        entityId: batch.id,
        action: '纠偏批次生效',
        operator,
        detail: `批次${batch.id}：检测版本+限速版本+缺陷位置同批生效；立即重定位${relocateCount}项，复测结论失效重算${retestCount}项，已关闭缺陷列入复议${reviewCount}项`,
        createdAt: effectiveAt
      }
    }
  ]

  return { inspectionVersion, speedVersion, outcomes, writeKeys: writes.map((item) => item.key), writes }
}

function auditForOutcome(outcome: BatchDefectOutcome, operator: string, at: string, inspectionVersionNumber: number): AuditDraft {
  if (outcome.kind === '重定位') {
    return {
      entityId: outcome.defectId,
      action: '未关闭缺陷重新定位',
      operator,
      detail: `里程 ${formatKm(outcome.oldMileage)} → ${formatKm(outcome.newMileage)}，检测版本重挂 V${inspectionVersionNumber}`,
      createdAt: at
    }
  }
  if (outcome.kind === '复测失效重算') {
    const rounds = (outcome.retestRecompute ?? []).map((item) => `第${item.round}轮 ${item.oldPassed ? '合格' : '不合格'}→重算${item.repass ? '合格' : '不合格'}（${item.measuredValue}/${item.limit}@${formatKm(item.sampleMileage)}）`).join('；')
    return {
      entityId: outcome.defectId,
      action: '复测结论失效并重算',
      operator,
      detail: `旧里程位置复测结论全部失效；${rounds}；里程 ${formatKm(outcome.oldMileage)} → ${formatKm(outcome.newMileage)}`,
      createdAt: at
    }
  }
  return {
    entityId: outcome.defectId,
    action: '已关闭缺陷列入复议',
    operator,
    detail: outcome.reviewReason ?? '关闭当时依据保留，待人工复议',
    createdAt: at
  }
}

/** 审计条目在批次内的稳定编号，保证重试不重复写 */
export function auditIdFor(batchId: string, writeKey: string): string {
  return `A-${batchId}-${writeKey}`
}

export function toAuditEntry(batchId: string, writeKey: string, draft: AuditDraft): AuditEntry {
  return { id: auditIdFor(batchId, writeKey), ...draft, batchId }
}

/** 限速联查：存在未关闭一级缺陷时，临时限速必须低于正式限速 */
export function speedConflict(defects: Defect[], segmentId: string, speed: number, temporary: number | undefined): boolean {
  const blocking = defects.some((item) => item.segmentId === segmentId && item.status !== '已关闭' && item.severity === '一级')
  return blocking && (!temporary || temporary >= speed)
}
