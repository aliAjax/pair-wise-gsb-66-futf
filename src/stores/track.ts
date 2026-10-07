import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  backfillInspectionVersions, batchIdOf, buildCorrectionPlan, confirmDefectVersions,
  ensureClosedBasis, fmtMileage, resolveImportConflict, windowKeyOf
} from '../services/correction'
import { seedAudit, seedDefects, seedInspectionVersions, seedSegments } from '../data/seed'
import type {
  AuditEntry, BatchPlan, CorrectionBatch, CorrectionPayload, Defect, DefectStatus,
  InspectionVersion, RectificationAction, ReconsiderationItem, RetestResult, TrackSegment, TrackState
} from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10

function freshState(): TrackState {
  return {
    schemaVersion: 2,
    segments: structuredClone(seedSegments),
    defects: structuredClone(seedDefects),
    audit: structuredClone(seedAudit),
    inspectionVersions: structuredClone(seedInspectionVersions),
    batches: [],
    reconsiderations: []
  }
}

/** 旧版本（v1，无检测版本与纠偏批次）迁移：旧数据按测量时间和文件摘要回填，无法确认的先待核 */
function migrate(raw: any): TrackState {
  const state = freshState()
  if (!raw || typeof raw !== 'object') return state
  if (raw.schemaVersion === 2 && Array.isArray(raw.segments)) return raw as TrackState

  // v1：segments / defects / audit
  const segments: TrackSegment[] = Array.isArray(raw.segments) ? raw.segments : structuredClone(seedSegments)
  const defects: Defect[] = Array.isArray(raw.defects) ? raw.defects : structuredClone(seedDefects)
  const audit: AuditEntry[] = Array.isArray(raw.audit) ? raw.audit : structuredClone(seedAudit)

  // 采样点回填检测版本（按测量时间分组 + 文件摘要）
  const { inspectionVersions, migrationAudits } = backfillInspectionVersions(segments)
  ensureClosedBasis(defects)
  const defectAudits = confirmDefectVersions(defects, inspectionVersions, segments)

  // 区段限速历史缺失时按当前限速补齐初始版本
  for (const segment of segments) {
    if (!Array.isArray(segment.speedLimitHistory)) {
      segment.speedLimitHistory = [{
        version: segment.version,
        speedLimit: segment.speedLimit,
        temporarySpeedLimit: segment.temporarySpeedLimit,
        changedAt: new Date().toISOString(),
        note: '迁移补齐的初始限速版本'
      }]
    }
  }

  return {
    schemaVersion: 2,
    segments,
    defects,
    audit: [...audit, ...migrationAudits.map((entry, index) => ({ ...entry, id: `A-MIG-${index}-1` })), ...defectAudits.map((entry, index) => ({ ...entry, id: `A-MIG-${index}-2` }))],
    inspectionVersions,
    batches: [],
    reconsiderations: []
  }
}

function load(): TrackState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return migrate(raw ? JSON.parse(raw) : null)
  } catch {
    return freshState()
  }
}

/** 单批次落地执行结果 */
type ApplyOutcome =
  | { ok: true; applied: number }
  | { ok: false; failedOp: string; applied: number; message: string }

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const inspectionVersions = ref<InspectionVersion[]>(initial.inspectionVersions)
  const batches = ref<CorrectionBatch[]>(initial.batches)
  const reconsiderations = ref<ReconsiderationItem[]>(initial.reconsiderations)

  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  /** 一次性写入失败注入：下一个匹配前缀的操作抛错，随后自动清除（不持久化） */
  let failOnPrefix: string | null = null

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))

  function addAudit(entityId: string, action: string, operator: string, detail: string, batchId?: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString(), batchId })
  }

  function nextBatchSeq(segmentId: string): number {
    return batches.value.filter((batch) => batch.segmentId === segmentId).length + 1
  }

  /** 同窗口先到批次（生效或已部分落地的失败批次）的纠偏量，作为后到方案的窗口前基线 */
  function sameWindowBaseOffset(segmentId: string, windowKey: string): number {
    const previous = batches.value
      .filter((batch) => batch.segmentId === segmentId && batch.windowKey === windowKey && (batch.status === '生效' || batch.status === '写入失败'))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]
    return previous?.payload.offset ?? 0
  }

  /**
   * 导入补测纠偏结果：
   * 同区段两个窗口（同补测日期）同时导入时，先到版本生效、后到内容完整保留为待复核。
   */
  function importCorrection(payload: CorrectionPayload, operator = '轨检车补测'): { ok: boolean; message: string; batchId?: string } {
    const segment = segments.value.find((item) => item.id === payload.segmentId)
    if (!segment) return { ok: false, message: '区段不存在' }

    // 限速安全规则同样适用于批次内调整：一级缺陷未关闭时临时限速必须更低
    if (payload.speedLimit !== undefined) {
      const nextTemporary = payload.temporarySpeedLimit ?? segment.temporarySpeedLimit
      const hasOpenCritical = defects.value.some((item) => item.segmentId === payload.segmentId && item.status !== '已关闭' && item.severity === '一级')
      if (hasOpenCritical && (!nextTemporary || nextTemporary >= payload.speedLimit)) {
        return { ok: false, message: '一级缺陷未关闭时，纠偏批次内的临时限速必须低于正式限速' }
      }
    }

    const verdict = resolveImportConflict(payload, batches.value)
    if (verdict.verdict === 'duplicate') return { ok: false, message: verdict.message }

    const seq = nextBatchSeq(payload.segmentId)
    const batchId = batchIdOf(payload.segmentId, payload.measuredAt, seq)
    // 同窗口已有生效（或失败已部分落地）批次时，计划按窗口前基线编排，后到方案只补差额
    const baseOffset = sameWindowBaseOffset(payload.segmentId, payload.windowKey)
    const plan = buildCorrectionPlan(payload, batchId, operator, segment, defects.value, baseOffset)
    const batch: CorrectionBatch = {
      id: batchId,
      segmentId: payload.segmentId,
      windowKey: payload.windowKey,
      status: '待复核',
      fileDigest: plan.inspectionVersion?.fileDigest ?? payload.fileDigest ?? 'N/A',
      measuredAt: payload.measuredAt,
      importedAt: new Date().toISOString(),
      payload: structuredClone(toPersistPayload(payload)),
      plan: structuredClone(plan),
      landedOps: []
    }

    if (verdict.verdict === 'pending') {
      // 后到内容完整保留待复核，先到版本保持生效不改动；本次未执行落地，注入不消费
      batch.status = '待复核'
      batch.supersededBatchId = verdict.previousBatchId
      batch.note = `同导入窗口后到，先到批次 ${verdict.previousBatchId}（${verdict.previousStatus}）优先；内容已完整保留，等待复核`
      batches.value.unshift(batch)
      addAudit(batchId, '纠偏批次·待复核', operator, batch.note)
      return { ok: true, message: batch.note, batchId }
    }

    batches.value.unshift(batch)
    const outcome = applyPlan(batch)
    failOnPrefix = null
    return outcome.ok
      ? { ok: true, message: `批次 ${batchId} 已生效：检测版本、缺陷重定位与限速版本同批落地`, batchId }
      : { ok: false, message: `批次 ${batchId} 在操作「${opLabel(outcome.failedOp)}」写入失败：${outcome.message}。完整检测批次已保留，可从批次恢复重试`, batchId }
  }

  function toPersistPayload(payload: CorrectionPayload): CorrectionPayload {
    return {
      segmentId: payload.segmentId,
      measuredAt: payload.measuredAt,
      detector: payload.detector,
      fileDigest: payload.fileDigest,
      windowKey: payload.windowKey,
      startMileage: payload.startMileage,
      endMileage: payload.endMileage,
      offset: payload.offset,
      measurements: payload.measurements,
      speedLimit: payload.speedLimit,
      temporarySpeedLimit: payload.temporarySpeedLimit,
      note: payload.note
    }
  }

  /**
   * 原子落地：按计划操作键顺序执行；
   * 已落地对象键直接跳过（已生效版本不重复改动），失败点之后的操作保持未落地。
   */
  function applyPlan(batch: CorrectionBatch): ApplyOutcome {
    const plan = batch.plan
    // 排队（待复核）期间计划可能补入新的复议操作键；生效时间统一刷新为实际落地时间
    const now = new Date().toISOString()
    for (const audit of plan.audits) audit.createdAt = now
    if (plan.inspectionVersion) plan.inspectionVersion.importedAt = now
    plan.speedVersion.changedAt = now

    const segment = segments.value.find((item) => item.id === batch.segmentId)
    if (!segment) return { ok: false, failedOp: 'segment-stamp', applied: 0, message: '区段不存在' }
    let applied = 0

    const mark = (op: string) => {
      if (!batch.landedOps.includes(op)) {
        batch.landedOps.push(op)
        applied += 1
      }
    }
    const landed = (op: string) => batch.landedOps.includes(op)
    const fail = (op: string, message: string): ApplyOutcome => {
      batch.status = '写入失败'
      batch.failedOp = op
      batch.failureReason = message
      return { ok: false, failedOp: op, applied, message }
    }

    for (const op of plan.allOps) {
      if (landed(op)) continue
      try {
        if (failOnPrefix && op.startsWith(failOnPrefix)) {
          const reason = `模拟写入失败（操作 ${op}）`
          failOnPrefix = null
          throw new Error(reason)
        }

        if (op === 'iv' && plan.inspectionVersion) {
          if (!inspectionVersions.value.some((item) => item.id === plan.inspectionVersion!.id)) {
            inspectionVersions.value.unshift({ ...plan.inspectionVersion })
          }
        } else if (op === 'measurements') {
          segment.measurements = plan.measurements.map((point) => ({ ...point }))
        } else if (op === 'segment-stamp') {
          segment.startMileage = plan.rangeStart
          segment.endMileage = plan.rangeEnd
        } else if (op === 'speed') {
          // 待复核批次可能晚于其他批次生效：按当前版本重新取号，避免限速版本撞号或回退
          const previousVersion = segment.version
          if (plan.speedVersion.version <= segment.version) plan.speedVersion.version = segment.version + 1
          segment.speedLimit = plan.speedVersion.speedLimit
          segment.temporarySpeedLimit = plan.speedVersion.temporarySpeedLimit
          segment.version = plan.speedVersion.version
          if (!segment.speedLimitHistory.some((item) => item.version === plan.speedVersion.version && item.batchId === batch.id)) {
            segment.speedLimitHistory.push({ ...plan.speedVersion })
          }
          // 版本重排后同步刷新计划内审计文案，保证审计与实际生效版本一致
          if (previousVersion !== plan.speedVersion.version - 1) {
            for (const entry of plan.audits) {
              if (entry.action === '纠偏批次·限速版本生效') {
                entry.detail = `限速 V${previousVersion}→V${plan.speedVersion.version}（复核生效重排版本号），正式 ${plan.speedVersion.speedLimit} km/h，临时 ${plan.speedVersion.temporarySpeedLimit ?? '无'}`
              }
            }
          }
        } else if (op.startsWith('relocate:')) {
          relocateByPlan(batch, op.slice('relocate:'.length), plan)
        } else if (op.startsWith('reconsider:')) {
          const item = plan.reconsiderations.find((value) => value.defectId === op.slice('reconsider:'.length))
          if (item && !reconsiderations.value.some((value) => value.id === item.id)) reconsiderations.value.unshift({ ...item })
        } else if (op.startsWith('audit:')) {
          const index = Number(op.slice('audit:'.length))
          const entry = plan.audits[index]
          if (entry && !audit.value.some((value) => value.batchId === batch.id && value.action === entry.action && value.entityId === entry.entityId)) {
            audit.value.unshift({ ...entry, id: `A-${Date.now()}-${idSeed++}` })
          }
        } else if (op === 'batch-finalize') {
          segment.activeBatchId = batch.id
          batch.status = '生效'
          batch.decidedAt = new Date().toISOString()
          batch.decidedBy = batch.decidedBy ?? '轨检车补测'
          batch.failedOp = undefined
          batch.failureReason = undefined
        }
        mark(op)
      } catch (error) {
        return fail(op, error instanceof Error ? error.message : String(error))
      }
    }
    return { ok: true, applied }
  }

  /** 未关闭缺陷随里程变化立即重新定位：历史复测结论失效，结论重算状态 */
  function relocateByPlan(batch: CorrectionBatch, defectId: string, plan: BatchPlan) {
    const defect = defects.value.find((item) => item.id === defectId)
    const entry = plan.defects.find((item) => item.defectId === defectId)
    if (!defect || !entry) return
    if (defect.status === '已关闭') {
      // 批次排队期间缺陷被关闭：不改动关闭依据，转列为复议项
      const op = `reconsider:${defect.id}`
      if (!plan.reconsiderations.some((item) => item.defectId === defect.id)) {
        plan.reconsiderations.push({
          id: `RC-${defect.id.replace('GD-', '')}-${batch.id.slice(-3)}`,
          defectId: defect.id, segmentId: defect.segmentId, closedMileage: defect.mileage,
          newMileage: entry.to, delta: entry.delta, batchId: batch.id, raisedAt: new Date().toISOString(), status: '待复议'
        })
        // 动态补入落地计划（位置在审计前），重试时同样可追踪
        if (!plan.allOps.includes(op)) plan.allOps.splice(plan.allOps.findIndex((key) => key.startsWith('audit:')), 0, op)
      }
      if (!reconsiderations.value.some((value) => value.defectId === defect.id && value.batchId === batch.id)) {
        reconsiderations.value.unshift({ ...plan.reconsiderations.find((item) => item.defectId === defect.id)! })
      }
      if (!batch.landedOps.includes(op)) {
        batch.landedOps.push(op)
      }
      return
    }
    defect.mileageHistory.push({ from: entry.from, to: entry.to, delta: entry.delta, batchId: batch.id, at: new Date().toISOString() })
    defect.mileage = entry.to
    defect.inspectionVersionId = plan.inspectionVersion?.id
    defect.versionConfidence = '已确认'
    for (const retest of defect.retests) {
      if (!retest.invalidatedAt) {
        retest.invalidatedAt = new Date().toISOString()
        retest.invalidatedByBatchId = batch.id
        retest.invalidReason = `里程纠偏 ${entry.delta > 0 ? '+' : ''}${entry.delta} 米，复测点位随旧里程失效，结论需重算`
      }
    }
    // 结论重算：全部历史复测失效后，状态回到待复测；已有整治记录可直接复测
    if (defect.retests.length && defect.retests.every((retest) => retest.invalidatedAt)) defect.status = '待复测'
    defect.version += 1
  }

  /** 从完整检测批次恢复：重试只处理未落地对象，已生效版本不重复改动 */
  function retryBatch(batchId: string): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status === '生效') return { ok: false, message: '批次已生效，不重复改动' }
    if (batch.status === '作废') return { ok: false, message: '批次已作废，不能重试' }
    if (batch.status === '待复核') return { ok: false, message: '批次处于待复核，请先在复核中确认生效或作废' }
    // 同窗口若已有其他生效批次，重试会产生版本冲突，先作废再走复核
    const blocked = batches.value.find((item) => item.id !== batchId && item.segmentId === batch.segmentId && item.windowKey === batch.windowKey && item.status === '生效')
    if (blocked) return { ok: false, message: `同窗口批次 ${blocked.id} 已生效，请作废本批次后重新复核，避免重复改动已生效版本` }

    const outcome = applyPlan(batch)
    return outcome.ok
      ? { ok: true, message: `批次 ${batchId} 恢复完成：新落地 ${outcome.applied} 个对象，已落地 ${batch.landedOps.length - outcome.applied} 个对象保持不变` }
      : { ok: false, message: `批次 ${batchId} 仍在操作「${opLabel(outcome.failedOp)}」失败：${outcome.message}` }
  }

  /** 待复核批次复核通过：后到内容经确认后生效，前一生效批次被取代（内容仍保留） */
  function approveBatch(batchId: string, operator = '工务调度', note = '复核通过，后到纠偏结果生效'): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待复核') return { ok: false, message: '仅待复核批次可确认生效' }

    // 同窗口若存在写入失败批次，先恢复或作废，避免已部分落地的对象被替代方案二次改动
    const blocked = batches.value.find((item) => item.id !== batchId && item.segmentId === batch.segmentId && item.windowKey === batch.windowKey && item.status === '写入失败')
    if (blocked) return { ok: false, message: `同窗口批次 ${blocked.id} 存在写入失败，请先恢复重试或作废后再复核` }

    // 按窗口前基线重建计划：批准前若又有同窗口批次生效，后到方案仍以窗口前原始里程为基准。
    // 必须在取代旧批次之前计算基线偏移量。
    const segment = segments.value.find((item) => item.id === batch.segmentId)
    let previous: CorrectionBatch | undefined
    let baseOffset = 0
    if (segment) {
      const activeChain = batches.value.filter((item) => item.id !== batch.id && item.segmentId === batch.segmentId && item.windowKey === batch.windowKey && item.status === '生效')
      baseOffset = activeChain.reduce((sum, item) => sum + item.payload.offset, 0)
      previous = activeChain.sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0] ?? batches.value.find((item) => item.id === batch.supersededBatchId)
    }
    if (previous && previous.status === '生效') {
      previous.status = '作废'
      previous.decidedAt = new Date().toISOString()
      previous.decidedBy = operator
      previous.note = `被复核通过的后到批次 ${batch.id} 取代，完整内容保留备查`
      batch.supersededBatchId = previous.id
      // 被取代批次已产生的待复议项随之作废，新批次计划内的复议项接管
      for (const item of reconsiderations.value) {
        if (item.batchId === previous.id && item.status === '待复议') {
          item.status = '随批次作废'
          item.resolvedAt = new Date().toISOString()
          item.resolvedBy = operator
          item.resolutionNote = `所属批次 ${previous.id} 被后到批次 ${batch.id} 取代`
        }
      }
    }
    if (segment) {
      batch.plan = buildCorrectionPlan(batch.payload, batch.id, operator, segment, defects.value, baseOffset)
      batch.landedOps = []
      batch.fileDigest = batch.plan.inspectionVersion?.fileDigest ?? batch.fileDigest
    }
    batch.decidedBy = operator
    const outcome = applyPlan(batch)
    if (!outcome.ok) return { ok: false, message: `批次 ${batchId} 生效时在「${opLabel(outcome.failedOp)}」失败，可从完整批次恢复重试` }
    addAudit(batchId, '纠偏批次·复核生效', operator, `${note}；检测数据版本、缺陷定位与限速版本同批生效`)
    return { ok: true, message: `批次 ${batchId} 已复核生效` }
  }

  /** 待复核/失败批次作废：内容完整保留，仅状态标记 */
  function rejectBatch(batchId: string, operator = '工务调度', note = '复核不通过，批次作废，内容保留备查'): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status === '生效') return { ok: false, message: '已生效批次不能作废' }
    batch.status = '作废'
    batch.decidedAt = new Date().toISOString()
    batch.decidedBy = operator
    batch.note = note
    addAudit(batchId, '纠偏批次·作废', operator, note)
    return { ok: true, message: `批次 ${batchId} 已作废，内容保留备查` }
  }

  function setFailureInjection(prefix: string | null) {
    failOnPrefix = prefix
  }

  /** 复议处理：维持关闭（缺陷保持关闭时依据）或重新立项（按新里程重定位、原合格复测失效） */
  function resolveReconsideration(reconsiderationId: string, decision: '维持关闭' | '重新立项', operator = '工务调度', note = ''): { ok: boolean; message: string } {
    const item = reconsiderations.value.find((value) => value.id === reconsiderationId)
    if (!item) return { ok: false, message: '复议项不存在' }
    if (item.status !== '待复议') return { ok: false, message: '复议项已处理' }
    const defect = defects.value.find((value) => value.id === item.defectId)
    if (!defect) return { ok: false, message: '关联缺陷不存在' }

    item.status = decision
    item.resolvedAt = new Date().toISOString()
    item.resolvedBy = operator
    item.resolutionNote = note || (decision === '维持关闭' ? '关闭时依据有效，维持关闭' : '按纠偏后新里程重新立项')

    if (decision === '重新立项') {
      defect.mileageHistory.push({ from: item.closedMileage, to: item.newMileage, delta: item.delta, batchId: item.batchId, at: new Date().toISOString() })
      defect.mileage = item.newMileage
      for (const retest of defect.retests) {
        if (!retest.invalidatedAt) {
          retest.invalidatedAt = new Date().toISOString()
          retest.invalidatedByBatchId = item.batchId
          retest.invalidReason = '复议重新立项：关闭依据基于旧里程，复测结论失效重算'
        }
      }
      defect.status = '待复测'
      defect.version += 1
      defect.closedBasis = defect.closedBasis ? { ...defect.closedBasis, batchId: item.batchId } : undefined
      addAudit(defect.id, '复议·重新立项', operator, `按纠偏后里程 K${fmtMileage(item.newMileage)} 重新立项，关闭依据保留于复议项，复测结论失效重算`, item.batchId)
    } else {
      addAudit(defect.id, '复议·维持关闭', operator, `关闭时里程 K${fmtMileage(item.closedMileage)} 依据有效，维持关闭；新里程 K${fmtMileage(item.newMileage)} 仅记录偏差`, item.batchId)
    }
    return { ok: true, message: decision === '维持关闭' ? '已维持关闭，关闭依据保留' : '已按新里程重新立项，等待复测' }
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}${defect.versionConfidence === '待核' ? '；检测版本待核' : ''}`)
    }
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    if (retest.passed) {
      defect.closedBasis = {
        mileage: defect.mileage,
        retestRound: retest.round,
        measuredValue: retest.measuredValue,
        limit: retest.limit,
        tester: retest.tester,
        testedAt: retest.testedAt,
        closedAt: new Date().toISOString(),
        inspectionVersionId: defect.inspectionVersionId,
        note: `第${retest.round}轮复测 ${retest.measuredValue} 满足验收标准，关闭时里程 K${fmtMileage(defect.mileage)} 保留为当时依据`
      }
    }
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过，已记录关闭依据' : `第${retest.round}轮未通过`)
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed && !item.invalidatedAt))) return { ok: false, message: '没有有效合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const previous = defect.status
    defect.status = next
    defect.version += 1
    if (next === '已关闭') {
      const passed = [...defect.retests].filter((item) => item.passed && !item.invalidatedAt).sort((a, b) => b.testedAt.localeCompare(a.testedAt))[0]
      if (passed && !defect.closedBasis) {
        defect.closedBasis = {
          mileage: defect.mileage, retestRound: passed.round, measuredValue: passed.measuredValue, limit: passed.limit,
          tester: passed.tester, testedAt: passed.testedAt, closedAt: new Date().toISOString(), inspectionVersionId: defect.inspectionVersionId,
          note: `第${passed.round}轮复测 ${passed.measuredValue} 满足验收标准，关闭时里程 K${fmtMileage(defect.mileage)} 保留为当时依据`
        }
      }
    }
    addAudit(id, `状态流转：${next}`, '当前用户', `由${previous}流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    segment.speedLimitHistory.push({
      version: segment.version, speedLimit: speed, temporarySpeedLimit: temporary, changedAt: new Date().toISOString(),
      note: '手工限速调整（未绑定纠偏批次）'
    })
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}（V${segment.version}，手工调整）`)
    return { ok: true, message: `区段速度版本已更新至 V${segment.version}` }
  }

  function reset() {
    const state = freshState()
    segments.value = state.segments
    defects.value = state.defects
    audit.value = state.audit
    inspectionVersions.value = state.inspectionVersions
    batches.value = state.batches
    reconsiderations.value = state.reconsiderations
  }

  watch([segments, defects, audit, inspectionVersions, batches, reconsiderations], () => {
    const state: TrackState = {
      schemaVersion: 2,
      segments: segments.value, defects: defects.value, audit: audit.value,
      inspectionVersions: inspectionVersions.value, batches: batches.value, reconsiderations: reconsiderations.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, { deep: true })

  return {
    segments, defects, audit, inspectionVersions, batches, reconsiderations,
    keyword, status, selectedSegmentId, filtered, selectedSegment,
    importCorrection, retryBatch, approveBatch, rejectBatch, resolveReconsideration, setFailureInjection,
    assign, addAction, addRetest, transition, updateSegmentSpeed, addAudit, reset
  }
})

function opLabel(op: string): string {
  if (op === 'iv') return '检测数据版本'
  if (op === 'measurements') return '采样点里程'
  if (op === 'segment-stamp') return '区段里程'
  if (op === 'speed') return '区段限速版本'
  if (op.startsWith('relocate:')) return `缺陷重定位 ${op.slice(9)}`
  if (op.startsWith('reconsider:')) return `关闭缺陷复议 ${op.slice(12)}`
  if (op.startsWith('audit:')) return '审计留痕'
  if (op === 'batch-finalize') return '批次生效'
  return op
}

export { windowKeyOf }
