import { digestOfMeasurements } from '../data/seed'
import type {
  AuditEntry, BatchPlan, CorrectionBatch, CorrectionPayload, Defect, DefectPlanEntry,
  GeometryMeasurement, InspectionVersion, ReconsiderationItem, SpeedLimitVersion, TrackSegment
} from '../types'

/**
 * 纠偏批次领域服务（纯函数）：
 * - 检测数据版本、缺陷重定位、区段限速版本在同一批次计划内编排；
 * - 同区段同导入窗口后到内容保留待复核；
 * - 完整计划随批次持久化，写入失败后从完整检测批次恢复，重试只执行未落地操作。
 */

export const HOUR_MS = 3600 * 1000
const WINDOW_BACKFILL_LIMIT = 24 * HOUR_MS

export function shortOf(segmentId: string): string {
  return segmentId.replace('SEG-', '')
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** 同一区段、同一补测日期 = 同一导入窗口 */
export function windowKeyOf(segmentId: string, measuredAt: string): string {
  return `${segmentId}@${dayOf(measuredAt)}`
}

export function batchIdOf(segmentId: string, measuredAt: string, seq: number): string {
  return `CB-${shortOf(segmentId)}-${dayOf(measuredAt).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`
}

function inspectionIdOf(segmentId: string, measuredAt: string, digest: string, seq: number): string {
  return `IV-${shortOf(segmentId)}-${dayOf(measuredAt).replace(/-/g, '')}-${digest.slice(0, 4)}-${String(seq).padStart(2, '0')}`
}

/**
 * 依据完整检测批次（payload）预先生成原子落地计划。
 * 计划一旦生成随批次完整持久化，恢复重试不依赖任何中间状态。
 *
 * baseOffset：同一导入窗口内先生效批次的纠偏量。同日补测是对窗口前原始里程的
 * 独立替代方案（而非累加），后到批次生效时按窗口前基线重新定位，避免偏移叠加。
 */
export function buildCorrectionPlan(payload: CorrectionPayload, batchId: string, operator: string, segment: TrackSegment, defects: Defect[], baseOffset = 0): BatchPlan {
  const at = new Date().toISOString()

  // 1) 修正后的采样点：当前里程已含同窗口前批次的 baseOffset，替代生效时只补差额
  const shift = payload.offset - (payload.measurements ? 0 : baseOffset)
  const corrected: GeometryMeasurement[] = (payload.measurements ?? segment.measurements).map((point) => ({
    ...point,
    mileage: payload.measurements ? point.mileage : point.mileage + shift,
    measuredAt: payload.measuredAt,
    detector: payload.detector
  }))
  const digest = payload.fileDigest || digestOfMeasurements(corrected)
  const ivSeq = Number(batchId.split('-').pop()) || 1
  const rangeStart = payload.startMileage ?? segment.startMileage + (payload.measurements ? 0 : shift)
  const rangeEnd = payload.endMileage ?? segment.endMileage + (payload.measurements ? 0 : shift)
  const inspectionVersion: InspectionVersion = {
    id: inspectionIdOf(segment.id, payload.measuredAt, digest, ivSeq),
    segmentId: segment.id,
    measuredAt: payload.measuredAt,
    importedAt: at,
    fileDigest: digest,
    measurementIds: corrected.map((point) => point.id),
    batchId,
    confidence: '已确认',
    note: `补测纠偏批次，共 ${corrected.length} 个采样点，文件摘要 ${digest}`
  }
  const stampedMeasurements = corrected.map((point) => ({ ...point, inspectionVersionId: inspectionVersion.id }))

  // 2) 缺陷编排：未关闭缺陷里程变化即重定位、复测结论失效；已关闭缺陷保留依据并生成复议项。
  //    同窗口已有生效批次时，开放缺陷当前里程已含 baseOffset，替代方案只补差额；
  //    已关闭缺陷里程永远以关闭依据（窗口前里程）为基线。
  const defectEntries: DefectPlanEntry[] = []
  const reconsiderations: ReconsiderationItem[] = []
  for (const defect of defects.filter((item) => item.segmentId === segment.id)) {
    const closedBasis = defect.status === '已关闭' && defect.closedBasis ? defect.closedBasis.mileage : null
    const currentMileage = closedBasis ?? defect.mileage
    const baseMileage = closedBasis !== null ? closedBasis : currentMileage - baseOffset
    const targetMileage = baseMileage + payload.offset
    const moveDelta = targetMileage - currentMileage
    const open = defect.status !== '已关闭'
    defectEntries.push({ defectId: defect.id, from: currentMileage, to: targetMileage, delta: moveDelta, open })
    if (!open && payload.offset !== 0) {
      reconsiderations.push({
        id: `RC-${defect.id.replace('GD-', '')}-${ivSeq}`,
        defectId: defect.id,
        segmentId: segment.id,
        closedMileage: closedBasis!,
        newMileage: closedBasis! + payload.offset,
        delta: payload.offset,
        batchId,
        raisedAt: at,
        status: '待复议'
      })
    }
  }

  // 3) 区段限速版本与纠偏批次绑定（无调整时值不变，版本照常递增）
  const speedVersion: SpeedLimitVersion = {
    version: segment.version + 1,
    speedLimit: payload.speedLimit ?? segment.speedLimit,
    temporarySpeedLimit: payload.temporarySpeedLimit ?? segment.temporarySpeedLimit,
    batchId,
    changedAt: at,
    note: `纠偏批次 ${batchId} 接入限速版本`
  }

  // 4) 审计条目（id 与落地时间在写入时分配，保证生效批次统一留痕）
  const audits: Array<Omit<AuditEntry, 'id'>> = [
    { entityId: inspectionVersion.id, action: '纠偏批次·检测数据版本生效', operator, detail: `${inspectionVersion.id} 绑定批次 ${batchId}，文件摘要 ${digest}，${corrected.length} 个采样点`, createdAt: at, batchId },
    { entityId: segment.id, action: '纠偏批次·里程纠偏', operator, detail: `区段里程整体平移 ${payload.offset > 0 ? '+' : ''}${payload.offset} 米：K${fmtMileage(segment.startMileage)}→K${fmtMileage(rangeStart)} 起`, createdAt: at, batchId },
    { entityId: segment.id, action: '纠偏批次·限速版本生效', operator, detail: `限速 V${segment.version}→V${segment.version + 1}，正式 ${speedVersion.speedLimit} km/h，临时 ${speedVersion.temporarySpeedLimit ?? '无'}`, createdAt: at, batchId }
  ]
  for (const entry of defectEntries) {
    if (entry.delta === 0) continue
    if (entry.open) {
      audits.push({
        entityId: entry.defectId, action: '纠偏批次·缺陷重新定位', operator,
        detail: `里程随纠偏重定位 K${fmtMileage(entry.from)}→K${fmtMileage(entry.to)}，绑定检测版本 ${inspectionVersion.id}，历史复测结论失效待重算`,
        createdAt: at, batchId
      })
    } else {
      audits.push({
        entityId: entry.defectId, action: '纠偏批次·关闭缺陷复议', operator,
        detail: `已关闭缺陷保留当时依据（K${fmtMileage(entry.from)}），纠偏后新里程 K${fmtMileage(entry.to)}，列入复议项`,
        createdAt: at, batchId
      })
    }
  }
  audits.push({ entityId: batchId, action: '纠偏批次生效', operator, detail: `检测数据版本、缺陷定位与区段限速 V${segment.version + 1} 在同一批次生效`, createdAt: at, batchId })

  // 5) 有序操作键：已落地对象重试时整体跳过，已生效版本不重复改动
  const allOps: string[] = ['iv', 'measurements', 'segment-stamp', 'speed']
  for (const entry of defectEntries) {
    if (entry.delta === 0) continue
    allOps.push(entry.open ? `relocate:${entry.defectId}` : `reconsider:${entry.defectId}`)
  }
  audits.forEach((_, index) => allOps.push(`audit:${index}`))
  allOps.push('batch-finalize')

  return { allOps, rangeStart, rangeEnd, inspectionVersion, measurements: stampedMeasurements, defects: defectEntries, reconsiderations, speedVersion, audits }
}

export function fmtMileage(mileage: number): string {
  return `${Math.floor(mileage / 1000)}+${String(mileage % 1000).padStart(3, '0')}`
}

/**
 * 导入窗口裁决：
 * - 同一文件摘要重复导入直接拒绝；
 * - 同区段同补测日期（同一导入窗口）已有生效/待复核/失败批次时，后到内容保留待复核。
 */
export type ImportVerdict =
  | { verdict: 'apply' }
  | { verdict: 'duplicate'; message: string }
  | { verdict: 'pending'; previousBatchId: string; previousStatus: CorrectionBatch['status'] }

export function resolveImportConflict(payload: CorrectionPayload, batches: CorrectionBatch[]): ImportVerdict {
  const sameSegment = batches.filter((batch) => batch.segmentId === payload.segmentId && batch.status !== '作废')
  const digest = payload.fileDigest || digestOfMeasurements(payload.measurements ?? [])
  const duplicated = sameSegment.find((batch) => batch.fileDigest === digest)
  if (duplicated) return { verdict: 'duplicate', message: `检测文件摘要 ${digest} 已存在于批次 ${duplicated.id}（${duplicated.status}），请勿重复导入` }
  const previous = sameSegment
    .filter((batch) => batch.windowKey === payload.windowKey && (batch.status === '生效' || batch.status === '待复核' || batch.status === '写入失败'))
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]
  if (previous) return { verdict: 'pending', previousBatchId: previous.id, previousStatus: previous.status }
  return { verdict: 'apply' }
}

/**
 * 旧数据回填：按测量时间与文件摘要生成检测数据版本；
 * 缺陷按发现时间与检测批次窗口（24 小时内）确认，无法确认的先待核。
 */
export interface BackfillResult {
  inspectionVersions: InspectionVersion[]
  migrationAudits: Array<Omit<AuditEntry, 'id'>>
}

export function backfillInspectionVersions(segments: TrackSegment[]): BackfillResult {
  const inspectionVersions: InspectionVersion[] = []
  const migrationAudits: Array<Omit<AuditEntry, 'id'>> = []
  const at = new Date().toISOString()

  for (const segment of segments) {
    // 按测量日期 + 检测设备归组，每组生成一个检测版本，摘要取采样点内容哈希
    const groups = new Map<string, GeometryMeasurement[]>()
    for (const point of segment.measurements) {
      const key = `${dayOf(point.measuredAt)}|${point.detector}`
      const list = groups.get(key) ?? []
      list.push(point)
      groups.set(key, list)
    }
    let seq = 1
    for (const [, points] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const digest = digestOfMeasurements(points)
      const version: InspectionVersion = {
        id: inspectionIdOf(segment.id, points.map((p) => p.measuredAt).sort()[0], digest, seq++),
        segmentId: segment.id,
        measuredAt: points.map((p) => p.measuredAt).sort()[0],
        importedAt: at,
        fileDigest: digest,
        measurementIds: points.map((point) => point.id),
        confidence: '已确认',
        note: '旧数据按测量时间与文件摘要回填的检测版本'
      }
      for (const point of points) point.inspectionVersionId = version.id
      inspectionVersions.push(version)
      migrationAudits.push({ entityId: version.id, action: '旧数据回填检测版本', operator: '系统迁移', detail: `按测量时间与文件摘要 ${digest} 回填 ${points.length} 个采样点`, createdAt: at })
    }
  }

  return { inspectionVersions, migrationAudits }
}

/** 缺陷回填：发现时间早于检测批次超过 24 小时（或无批次）即待核 */
export function confirmDefectVersions(defects: Defect[], versions: InspectionVersion[], segments: TrackSegment[]): Array<Omit<AuditEntry, 'id'>> {
  const audits: Array<Omit<AuditEntry, 'id'>> = []
  const at = new Date().toISOString()
  for (const defect of defects) {
    if (defect.versionConfidence) continue
    const candidates = versions
      .filter((version) => version.segmentId === defect.segmentId)
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))
    const matched = candidates.find((version) => {
      const latest = latestMeasurementAt(version, segments)
      const gap = new Date(defect.discoveredAt).getTime() - new Date(latest).getTime()
      return gap >= -HOUR_MS && gap <= WINDOW_BACKFILL_LIMIT
    })
    if (matched) {
      defect.inspectionVersionId = matched.id
      defect.versionConfidence = '已确认'
    } else {
      defect.versionConfidence = '待核'
      audits.push({ entityId: defect.id, action: '检测版本待核', operator: '系统迁移', detail: '按测量时间与文件摘要无法确认检测批次，先标记待核，待补测纠偏批次确认', createdAt: at })
    }
  }
  return audits
}

function latestMeasurementAt(version: InspectionVersion, segments: TrackSegment[]): string {
  const segment = segments.find((item) => item.id === version.segmentId)
  const times = segment?.measurements.filter((point) => version.measurementIds.includes(point.id)).map((point) => point.measuredAt) ?? []
  return times.sort().pop() ?? version.measuredAt
}

/** 已关闭缺陷保留当时依据：迁移旧数据时从合格复测补齐 */
export function ensureClosedBasis(defects: Defect[]): void {
  for (const defect of defects) {
    if (defect.status === '已关闭' && !defect.closedBasis) {
      const passed = [...defect.retests].filter((retest) => retest.passed).sort((a, b) => b.testedAt.localeCompare(a.testedAt))[0]
      if (passed) {
        defect.closedBasis = {
          mileage: defect.mileage,
          retestRound: passed.round,
          measuredValue: passed.measuredValue,
          limit: passed.limit,
          tester: passed.tester,
          testedAt: passed.testedAt,
          closedAt: passed.testedAt,
          inspectionVersionId: defect.inspectionVersionId,
          note: `第${passed.round}轮复测 ${passed.measuredValue} 满足验收标准，关闭时里程 K${fmtMileage(defect.mileage)} 保留为当时依据`
        }
      }
    }
    if (!defect.mileageHistory) defect.mileageHistory = []
  }
}
