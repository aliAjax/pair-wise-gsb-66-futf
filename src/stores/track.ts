import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type {
  AuditEntry, CorrectionBatch, Defect, DefectStatus, MileageMove,
  RecoveryJournal, RectificationAction, RetestResult, TrackSegment
} from '../types'
import {
  buildPayload, digest8, formatKm, prepareApplication, speedConflict, toAuditEntry,
  type CorrectionInput
} from '../domain/correction'
import { addPendingPlaceholders, migrateLegacy } from '../domain/migration'

const STORAGE_KEY = 'gsb66:track-geometry'
const SCHEMA = 2
let idSeed = 100

export interface ActionResult { ok: boolean; message: string; batchId?: string }
export type FailureInject = '无' | '检测写入后' | '缺陷写入中' | '限速写入后'
export interface PairResult { first: ActionResult; second: ActionResult }

const now = () => new Date().toISOString()

function loadInitial() {
  let raw: { schema?: number; segments?: TrackSegment[]; defects?: Defect[]; audit?: AuditEntry[]; batches?: CorrectionBatch[]; journals?: RecoveryJournal[] } | null = null
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (text) raw = JSON.parse(text)
  } catch {
    raw = null
  }
  if (!raw || raw.schema !== SCHEMA || !raw.segments) {
    const migrated = migrateLegacy({ segments: raw?.segments ?? structuredClone(seedSegments), defects: raw?.defects ?? structuredClone(seedDefects), audit: raw?.audit ?? structuredClone(seedAudit) })
    const segments = addPendingPlaceholders(migrated.segments, migrated.defects)
    return { schema: SCHEMA as number, segments, defects: migrated.defects, audit: migrated.audit, batches: [] as CorrectionBatch[], journals: [] as RecoveryJournal[] }
  }
  return {
    schema: SCHEMA,
    segments: raw.segments,
    defects: raw.defects ?? [],
    audit: raw.audit ?? [],
    batches: raw.batches ?? [],
    journals: raw.journals ?? []
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = loadInitial()
  const schema = ref(initial.schema)
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const batches = ref<CorrectionBatch[]>(initial.batches)
  const journals = ref<RecoveryJournal[]>(initial.journals)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingBatches = computed(() => batches.value.filter((item) => item.status === '待复核'))
  const interruptedJournals = computed(() => journals.value.filter((item) => item.status === '写入中断'))
  const reviewItems = computed(() => defects.value.filter((item) => item.closedBasis?.reviewBatchIds.length))

  function addAudit(entityId: string, action: string, operator: string, detail: string, batchId?: string) {
    const entry: AuditEntry = { id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: now(), batchId }
    audit.value.unshift(entry)
    return entry
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
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
    defect.retests.unshift({ ...retest, valid: true })
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
    if (retest.passed) snapshotClosedBasis(defect, retest.tester)
  }

  function snapshotClosedBasis(defect: Defect, closer = '当前用户') {
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    defect.closedBasis = {
      mileage: defect.mileage,
      inspectionVersionId: defect.inspectionVersionId ?? '待核',
      speedLimitVersionId: segment?.speedLimitVersions.slice(-1)[0]?.id ?? '待核',
      closedAt: now(),
      retestSnapshot: structuredClone(defect.retests),
      reviewBatchIds: defect.closedBasis?.reviewBatchIds ?? [],
      note: `${closer}关闭时里程、复测结论、检测版本与限速版本快照`
    }
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed && item.valid))) return { ok: false, message: '没有合格且有效的复测记录，不能关闭' }
    const previous = defect.status
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${previous}流转至${next}`)
    if (next === '已关闭') snapshotClosedBasis(defect)
    return { ok: true, message: `已流转至${next}` }  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    if (speedConflict(defects.value, id, speed, temporary)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    const versionNumber = segment.speedLimitVersions.reduce((max, item) => Math.max(max, item.version), 0) + 1
    const speedVersion = {
      id: `SV-MANUAL-${Date.now()}-${idSeed++}`,
      segmentId: id, version: versionNumber, speedLimit: speed, temporarySpeedLimit: temporary,
      effectiveAt: now(), source: '人工调整' as const, note: '人工速度联查调整'
    }
    segment.speedLimitVersions.push(speedVersion)
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'} km/h，限速版本 V${versionNumber}`)
    return { ok: true, message: '区段速度版本已更新' }
  }

  /* ---------------- 补测纠偏批次 ---------------- */

  function interruptedOf(segmentId: string) {
    return journals.value.find((item) => item.segmentId === segmentId && item.status === '写入中断')
  }

  /** 单窗口导入；或同一轮次双窗口同时导入（先到生效、后到待复核） */
  function importCorrectionPair(first: CorrectionInput, second?: CorrectionInput, failure: FailureInject = '无'): PairResult {
    const firstResult = registerCorrection(first, failure)
    if (!second) return { first: firstResult, second: { ok: true, message: '未提交第二窗口' } }
    // 第一窗口先落地（生效或写入中断），第二窗口一律作为后到内容保留待复核，不覆盖
    const secondResult = registerCorrection(second, '无', true)
    if (!firstResult.ok) {
      secondResult.message += '；第一窗口写入中断，待恢复后再完成版本仲裁'
    }
    return { first: firstResult, second: secondResult }
  }

  function registerCorrection(input: CorrectionInput, failure: FailureInject, forcePending = false): ActionResult {
    const segment = segments.value.find((item) => item.id === input.segmentId)
    if (!segment) return { ok: false, message: '区段不存在' }
    const sameRound = batches.value.find((item) => item.segmentId === input.segmentId && item.roundKey === input.roundKey)
    if (sameRound?.status === '待复核' && forcePending) return { ok: false, message: '同轮次后到窗口已保留待复核，不能重复排队' }
    // 已有中断批次时，新轮次导入必须先恢复；同轮次第二窗口仍按后到内容排队待复核
    if (interruptedOf(input.segmentId) && !(forcePending || sameRound)) {
      return { ok: false, message: '该区段存在写入中断的检测批次，请先从完整批次恢复后再导入' }
    }
    const otherPending = batches.value.find((item) => item.segmentId === input.segmentId && item.status === '待复核' && item.roundKey !== input.roundKey)
    if (otherPending && !forcePending) return { ok: false, message: `已有后到批次 ${otherPending.id} 待复核，请先完成复核` }
    const arrivesLater = forcePending || sameRound?.status === '生效' || sameRound?.status === '写入中断'
    const payload = buildPayload(segment, input)
    const batch: CorrectionBatch = {
      id: `BC-${input.importedAt.replace(/[-:T.Z]/g, '').slice(0, 14)}-${input.windowName.replace(/\s/g, '')}`,
      segmentId: input.segmentId,
      roundKey: input.roundKey,
      windowName: input.windowName,
      operator: input.operator,
      importedAt: input.importedAt,
      fileDigest: input.fileDigest,
      status: arrivesLater ? '待复核' : '生效',
      note: input.note,
      inspectionVersionId: '',
      speedLimitVersionId: '',
      anchorStartDelta: input.anchorStartDelta,
      anchorEndDelta: input.anchorEndDelta,
      outcomes: [],
      payload,
      input
    }
    batches.value.unshift(batch)
    if (arrivesLater) {
      addAudit(batch.id, '后到修正结果保留待复核', `${input.operator}（${input.windowName}）`,
        `同区段同轮次 ${input.roundKey} 已有${sameRound?.status === '写入中断' ? '中断批次' : '生效批次'} ${sameRound?.id ?? ''}，后到文件摘要 ${input.fileDigest} 内容保留不覆盖，待人工复核`)
      return { ok: true, message: `后到版本已保留待复核（批次 ${batch.id}），先到版本生效`, batchId: batch.id }
    }
    return applyBatch(batch, failure)
  }

  /** 从完整检测批次恢复：重试只处理未落地写入键，已生效版本不重复改动 */
  function recoverBatch(batchId: string): ActionResult {
    const journal = journals.value.find((item) => item.batchId === batchId)
    const batch = batches.value.find((item) => item.id === batchId)
    const segment = segments.value.find((item) => item.id === batch?.segmentId)
    if (!journal || !batch || !segment) return { ok: false, message: '恢复日志或完整检测批次缺失，无法恢复' }
    // 恢复沿用首次准备时快照的缺陷处置结果，避免已重定位缺陷被二次映射
    const prepared = prepareApplication(segment, defects.value, batch, now(), batch.outcomes.length ? batch.outcomes : undefined)
    const result = runWrites(batch, prepared, journal, '无', true)
    return result
  }

  /** 复核待复核批次：批准则作为新批次生效（当前版本不动，新版本整批写入）；驳回则保留记录 */
  function reviewPendingBatch(batchId: string, approve: boolean, reviewer: string, reviewNote: string): ActionResult {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch || batch.status !== '待复核') return { ok: false, message: '批次不是待复核状态' }
    batch.reviewedBy = reviewer
    batch.reviewedAt = now()
    batch.reviewNote = reviewNote
    if (!approve) {
      batch.status = '复核驳回'
      addAudit(batch.id, '驳回后到修正结果', reviewer, `复核驳回：${reviewNote || '维持先到生效版本'}`)
      return { ok: true, message: '已驳回，先到生效版本保持不变' }
    }
    const segment = segments.value.find((item) => item.id === batch.segmentId)
    if (!segment) return { ok: false, message: '区段不存在' }
    if (interruptedOf(segment.id)) return { ok: false, message: '存在写入中断批次，请先恢复' }
    // 按复核时点的区段状态重建完整载荷，生成新纠偏批次
    const rebuiltInput: CorrectionInput = { ...batch.input, roundKey: `R-${Date.now()}`, windowName: `${batch.windowName}·复核`, importedAt: now(), note: `${batch.note}（复核批准，源自 ${batch.id}）` }
    const fresh: CorrectionBatch = {
      ...batch,
      id: `BC-${rebuiltInput.importedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-REVIEW`,
      roundKey: rebuiltInput.roundKey,
      windowName: rebuiltInput.windowName,
      importedAt: rebuiltInput.importedAt,
      status: '生效',
      outcomes: [],
      payload: buildPayload(segment, rebuiltInput),
      input: rebuiltInput,
      reviewedBy: undefined,
      reviewedAt: undefined,
      reviewNote: undefined
    }
    batches.value.unshift(fresh)
    addAudit(batch.id, '批准后到修正结果', reviewer, `复核批准，作为新批次 ${fresh.id} 生效；${reviewNote}`)
    return applyBatch(fresh, '无')
  }

  function applyBatch(batch: CorrectionBatch, failure: FailureInject): ActionResult {
    const segment = segments.value.find((item) => item.id === batch.segmentId)
    if (!segment) return { ok: false, message: '区段不存在' }
    if (speedConflict(defects.value, segment.id, batch.payload.speedLimit, batch.payload.temporarySpeedLimit)) {
      batch.status = '待复核'
      return { ok: false, message: '纠偏限速未通过联查：一级缺陷未关闭时临时限速必须更低，批次转待复核', batchId: batch.id }
    }
    const prepared = prepareApplication(segment, defects.value, batch, now())
    batch.outcomes = prepared.outcomes
    batch.inspectionVersionId = prepared.inspectionVersion.id
    batch.speedLimitVersionId = prepared.speedVersion.id
    const journal: RecoveryJournal = {
      id: `J-${batch.id}`,
      batchId: batch.id,
      segmentId: segment.id,
      roundKey: batch.roundKey,
      status: '写入中断',
      writeKeys: prepared.writeKeys,
      landedKeys: [],
      lastError: '',
      failAfterKey: failure === '无' ? null : failure,
      createdAt: now(),
      updatedAt: now()
    }
    journals.value.unshift(journal)
    return runWrites(batch, prepared, journal, failure, false)
  }

  function runWrites(batch: CorrectionBatch, prepared: ReturnType<typeof prepareApplication>, journal: RecoveryJournal, failure: FailureInject, recovering: boolean): ActionResult {
    const segment = segments.value.find((item) => item.id === batch.segmentId)
    if (!segment) return { ok: false, message: '区段不存在' }
    const resolveStopKey = (mode: FailureInject): string | null => {
      if (mode === '检测写入后') return 'measurements'
      if (mode === '限速写入后') return 'speed'
      if (mode === '缺陷写入中') return prepared.writes.find((w) => w.key.startsWith('defect:') && prepared.outcomes.find((o) => `defect:${o.defectId}` === w.key)?.kind !== '复议项')?.key ?? prepared.writes.find((w) => w.key.startsWith('defect:'))?.key ?? null
      return null
    }
    const stopKey = failure === '无' ? null : resolveStopKey(failure)
    let processed = 0

    for (const write of prepared.writes) {
      if (!journal.landedKeys.includes(write.key)) {
        commitWrite(batch, prepared, write.key, segment)
        journal.landedKeys.push(write.key)
        journal.updatedAt = now()
        processed += 1
        if (!recovering && stopKey && write.key === stopKey) {
          journal.status = '写入中断'
          journal.lastError = `模拟故障：完成「${write.key}」写入后存储中断`
          batch.status = '写入中断'
          addAudit(batch.id, '纠偏批次写入中断', `${batch.operator}（${batch.windowName}）`, journal.lastError, batch.id)
          persist()
          return { ok: false, message: `${journal.lastError}；完整检测批次已保留，可从批次恢复`, batchId: batch.id }
        }
      }
    }

    // 全部写入落地：版本与批次收尾（幂等，恢复时不重复改动已生效版本）
    if (!segment.inspectionVersions.some((item) => item.id === prepared.inspectionVersion.id)) {
      segment.inspectionVersions.forEach((item) => { if (item.status === '生效') item.status = '历史' })
      segment.inspectionVersions.push(prepared.inspectionVersion)
    }
    if (!segment.speedLimitVersions.some((item) => item.id === prepared.speedVersion.id)) segment.speedLimitVersions.push(prepared.speedVersion)
    segment.activeBatchId = batch.id
    segment.speedLimit = batch.payload.speedLimit
    segment.temporarySpeedLimit = batch.payload.temporarySpeedLimit
    segment.version = prepared.speedVersion.version
    segment.startMileage = batch.payload.startMileage
    segment.endMileage = batch.payload.endMileage
    batch.status = '生效'
    batch.effectiveAt = batch.effectiveAt ?? now()
    batch.inspectionVersionId = prepared.inspectionVersion.id
    batch.speedLimitVersionId = prepared.speedVersion.id
    batch.outcomes = prepared.outcomes
    journal.status = '已恢复'
    journal.failAfterKey = null
    journal.lastError = ''
    journal.updatedAt = now()
    if (recovering) addAudit(batch.id, '从完整检测批次恢复', `${batch.operator}（${batch.windowName}）`, `重试只处理未落地对象：本次补写 ${processed} 项，已生效版本未重复改动`, batch.id)
    persist()
    return { ok: true, message: recovering ? `批次 ${batch.id} 已恢复，剩余对象补齐，已生效版本未改动` : `纠偏批次 ${batch.id} 已生效`, batchId: batch.id }
  }

  function commitWrite(batch: CorrectionBatch, prepared: ReturnType<typeof prepareApplication>, key: string, segment: TrackSegment) {
    const payload = batch.payload
    if (key === 'measurements') {
      // 已生效旧版本不重复改动：用纠偏后完整采样替换，采样点挂到本批检测版本
      segment.measurements = payload.correctedMeasurements.map((point) => ({ ...point, inspectionVersionId: prepared.inspectionVersion.id }))
    } else if (key === 'speed') {
      segment.speedLimit = payload.speedLimit
      segment.temporarySpeedLimit = payload.temporarySpeedLimit
    } else if (key === 'summary') {
      // 收尾在 runWrites 统一处理
    } else if (key.startsWith('defect:')) {
      const defectId = key.slice('defect:'.length)
      const outcome = prepared.outcomes.find((item) => item.defectId === defectId)
      const defect = defects.value.find((item) => item.id === defectId)
      if (!defect || !outcome) return
      if (outcome.kind === '复议项') {
        // 已关闭缺陷：保留关闭当时依据，只列复议项，不改里程/状态
        if (defect.closedBasis && !defect.closedBasis.reviewBatchIds.includes(batch.id)) {
          defect.closedBasis.reviewBatchIds.push(batch.id)
          defect.lastBatchId = batch.id
          defect.version += 1
        }
      } else {
        // 里程变化后未关闭缺陷立即重新定位
        const move: MileageMove = { fromMileage: outcome.oldMileage, toMileage: outcome.newMileage, batchId: batch.id, movedAt: now(), reason: '补测纠偏后按锚点重新定位' }
        defect.mileage = outcome.newMileage
        defect.mileageHistory.unshift(move)
        defect.inspectionVersionId = prepared.inspectionVersion.id
        defect.inspectionVersionUnverified = false
        defect.lastBatchId = batch.id
        defect.version += 1
        if (outcome.kind === '复测失效重算') {
          // 旧位置复测结论失效，按纠偏后就近采样重算
          for (const retest of defect.retests) {
            const recompute = outcome.retestRecompute?.find((item) => item.round === retest.round)
            if (!recompute || !retest.valid) continue
            retest.valid = false
            retest.invalidatedByBatchId = batch.id
            retest.recomputed = {
              passed: recompute.repass,
              measuredValue: recompute.measuredValue,
              sampleMileage: recompute.sampleMileage,
              note: `纠偏批次 ${batch.id} 后旧里程结论失效，按 ${formatKm(recompute.sampleMileage)} 采样重算：${recompute.repass ? '合格' : '仍超限'}`
            }
          }
          defect.status = outcome.retestRecompute?.every((item) => item.repass) ? '待复测' : '复测不合格'
        }
      }
    }
    const write = prepared.writes.find((item) => item.key === key)
    if (write?.audit && !audit.value.some((item) => item.id === `A-${batch.id}-${key}`)) {
      audit.value.unshift(toAuditEntry(batch.id, key, write.audit))
    }
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schema: schema.value, segments: segments.value, defects: defects.value, audit: audit.value, batches: batches.value, journals: journals.value
    }))
  }

  function reset() {
    const migrated = migrateLegacy({ segments: structuredClone(seedSegments), defects: structuredClone(seedDefects), audit: structuredClone(seedAudit) })
    segments.value = addPendingPlaceholders(migrated.segments, migrated.defects)
    defects.value = migrated.defects
    audit.value = migrated.audit
    batches.value = []
    journals.value = []
  }

  watch([segments, defects, audit, batches, journals], persist, { deep: true })

  return {
    schema, segments, defects, audit, batches, journals,
    keyword, status, selectedSegmentId, filtered, selectedSegment,
    pendingBatches, interruptedJournals, reviewItems,
    assign, addAction, addRetest, transition, updateSegmentSpeed,
    importCorrectionPair, recoverBatch, reviewPendingBatch, reset,
    digestPreview: (text: string) => digest8(text)
  }
})
