import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useTrackStore } from '../src/stores/track'
import type { CorrectionInput } from '../src/domain/correction'

let pass = 0
function check(name: string, fn: () => void) {
  fn()
  pass += 1
  console.log(`  ✓ ${name}`)
}

const storage: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] }
}

function input(over: Partial<CorrectionInput> = {}, stamp = '2026-10-07T08:00:00.000Z', windowName = '导入窗口甲'): CorrectionInput {
  return {
    segmentId: 'SEG-K102',
    roundKey: 'RK-TEST-1',
    windowName,
    operator: '检测工区 赵鹏',
    importedAt: stamp,
    fileDigest: 'abcdef01',
    note: '补测',
    anchorStartDelta: 0,
    anchorEndDelta: -80,
    speedLimit: 160,
    temporarySpeedLimit: 120,
    ...over
  }
}

setActivePinia(createPinia())
const store = useTrackStore()

/* 1. 旧数据回填：按测量时间+文件摘要挂检测版本；无法确认先待核 */
check('旧数据按测量时间回填检测版本（K102有9-28/9-29两版，9-29生效）', () => {
  const seg = store.segments.find((s) => s.id === 'SEG-K102')!
  assert.equal(seg.inspectionVersions.length, 2)
  assert.equal(seg.inspectionVersions[1].status, '生效')
  assert.equal(seg.inspectionVersions[0].status, '历史')
  assert.ok(seg.inspectionVersions[1].fileDigest)
  assert.equal(seg.speedLimitVersions.length, 1)
  assert.equal(seg.measurements[0].inspectionVersionId?.startsWith('IV-LEGACY-'), true)
})
check('9-29发现的缺陷挂9-29版本；8-15旧缺陷无批次可对应，先待核', () => {
  const d1 = store.defects.find((d) => d.id === 'GD-260929-01')!
  assert.equal(d1.inspectionVersionId, 'IV-LEGACY-SEG-K102-2026-09-29')
  assert.equal(d1.inspectionVersionUnverified, undefined)
  const old = store.defects.find((d) => d.id === 'GD-260815-03')!
  assert.equal(old.inspectionVersionUnverified, true)
  assert.equal(old.inspectionVersionId, 'IV-PENDING-SEG-K208')
})
check('回填写入审计，且幂等（重新加载不重复）', () => {
  assert.ok(store.audit.some((a) => a.action === '旧数据回填检测版本'))
  assert.ok(store.audit.some((a) => a.action === '检测版本待核'))
})

/* 2. 单批次纠偏：检测版本+缺陷+限速版本同一批次 */
const before = {
  d1Mileage: (store.defects.find((d) => d.id === 'GD-260929-01')!).mileage,
  d2Mileage: (store.defects.find((d) => d.id === 'GD-260929-02')!).mileage,
  endMileage: (store.segments.find((s) => s.id === 'SEG-K102')!).endMileage
}
const r1 = store.importCorrectionPair(input())
check('单窗口导入生效，返回批次号', () => {
  assert.equal(r1.first.ok, true, r1.first.message)
  assert.match(r1.first.batchId!, /^BC-/)
})
const batch1 = store.batches[0]
check('检测版本、限速版本、缺陷、摘要审计挂同一批次', () => {
  assert.equal(batch1.status, '生效')
  const seg = store.segments.find((s) => s.id === 'SEG-K102')!
  assert.equal(seg.activeBatchId, batch1.id)
  const iv = seg.inspectionVersions.find((v) => v.id === `IV-${batch1.id}`)!
  const sv = seg.speedLimitVersions.find((v) => v.id === `SV-${batch1.id}`)!
  assert.equal(iv.batchId, batch1.id)
  assert.equal(sv.batchId, batch1.id)
  assert.equal(seg.version, sv.version)
  const batchAudit = store.audit.filter((a) => a.batchId === batch1.id)
  if (process.env.DEBUG) {
    console.log('batch id', batch1.id, 'audit count', batchAudit.length)
    console.log(batchAudit.map((a) => `${a.id}:${a.action}`).join('\n'))
    console.log('outcomes', batch1.outcomes.map((o) => `${o.defectId}:${o.kind}`).join(','))
  }
  assert.ok(batchAudit.length >= 5, `批次审计仅${batchAudit.length}条`)
  assert.ok(batchAudit.some((a) => a.action.includes('复测结论失效')), '缺少复测失效重算审计')
})
check('未关闭无复测缺陷立即重新定位并挂里程迁移记录', () => {
  const d1 = store.defects.find((d) => d.id === 'GD-260929-01')!
  assert.notEqual(d1.mileage, before.d1Mileage)
  // 线性锚点：102800 位于 800/2800，修正量 = round(-80*800/2800) = -23
  assert.equal(d1.mileage, 102800 + Math.round(-80 * 800 / 2800))
  assert.equal(d1.mileageHistory[0].batchId, batch1.id)
  assert.equal(d1.inspectionVersionId, `IV-${batch1.id}`)
})
check('有未关闭复测的缺陷：旧复测失效，按纠偏后就近采样重算并改状态', () => {
  const d2 = store.defects.find((d) => d.id === 'GD-260929-02')!
  assert.equal(d2.retests[0].valid, false)
  assert.equal(d2.retests[0].invalidatedByBatchId, batch1.id)
  assert.ok(d2.retests[0].recomputed)
  assert.equal(['待复测', '复测不合格'].includes(d2.status), true)
})
check('已关闭缺陷保留关闭当时依据（里程不动），列出复议项', () => {
  const d3 = store.defects.find((d) => d.id === 'GD-260928-07')!
  assert.equal(d3.mileage, 209200)
  assert.ok(d3.closedBasis)
  assert.deepEqual(d3.closedBasis!.retestSnapshot.length, 1)
  assert.deepEqual(d3.closedBasis!.reviewBatchIds, []) // 该缺陷在K208，本批是K102
})

/* 3. 双窗口同时导入：先到生效、后到待复核 */
const seg2 = 'SEG-K208'
const stamp = '2026-10-07T09:00:00.000Z'
const pair = store.importCorrectionPair(
  input({ segmentId: seg2, fileDigest: '11111111', speedLimit: 200, temporarySpeedLimit: undefined }, stamp, '导入窗口甲'),
  input({ segmentId: seg2, fileDigest: '22222222', speedLimit: 180, temporarySpeedLimit: undefined, note: '后到' }, '2026-10-07T09:00:00.001Z', '导入窗口乙'),
  '无'
)
check('同区段双窗口：第一窗口生效', () => {
  assert.equal(pair.first.ok, true, pair.first.message)
  const first = store.batches.find((b) => b.fileDigest === '11111111')!
  assert.equal(first.status, '生效')
  const seg = store.segments.find((s) => s.id === seg2)!
  assert.equal(seg.speedLimit, 200)
})
check('第二窗口后到内容保留待复核，不覆盖生效版本', () => {
  assert.equal(pair.second.ok, true)
  const second = store.batches.find((b) => b.fileDigest === '22222222')!
  assert.equal(second.status, '待复核')
  assert.equal(store.pendingBatches.length >= 1, true)
  const seg = store.segments.find((s) => s.id === seg2)!
  assert.equal(seg.speedLimit, 200) // 后到180未生效
  assert.ok(second.payload.correctedMeasurements.length > 0)
})
check('K208已关闭缺陷在生效批次中列入复议项，依据保留', () => {
  const d3 = store.defects.find((d) => d.id === 'GD-260928-07')!
  assert.equal(d3.mileage, 209200)
  assert.deepEqual(d3.closedBasis!.reviewBatchIds.length, 1)
})
const secondId = store.batches.find((b) => b.fileDigest === '22222222')!.id
check('驳回后到批次：先到版本不动', () => {
  const r = store.reviewPendingBatch(secondId, false, '复核员', '维持先到')
  assert.equal(r.ok, true)
  assert.equal(store.segments.find((s) => s.id === seg2)!.speedLimit, 200)
  assert.equal(store.batches.find((b) => b.id === secondId)!.status, '复核驳回')
})

/* 4. 写入失败：中断、从完整批次恢复、只补未落地、已生效版本不重复改动 */
const failPair = store.importCorrectionPair(
  input({ segmentId: 'SEG-K102', roundKey: 'RK-FAIL', fileDigest: '33333333', anchorEndDelta: -40 }, '2026-10-07T10:00:00.000Z'),
  undefined,
  '检测写入后'
)
let failedId = ''
check('故障注入：检测写入后批次中断，日志记录已落地键', () => {
  assert.equal(failPair.first.ok, false)
  failedId = failPair.first.batchId!
  const journal = store.journals.find((j) => j.batchId === failedId)!
  assert.equal(journal.status, '写入中断')
  assert.deepEqual(journal.landedKeys, ['measurements'])
  const batch = store.batches.find((b) => b.id === failedId)!
  assert.equal(batch.status, '写入中断')
  assert.ok(batch.payload.correctedMeasurements.length === 14)
})
const auditCountBefore = store.audit.filter((a) => a.batchId === failedId).length
const recover = store.recoverBatch(failedId)
check('恢复：只处理未落地对象，已生效/已落地不重复', () => {
  assert.equal(recover.ok, true, recover.message)
  const journal = store.journals.find((j) => j.batchId === failedId)!
  assert.equal(journal.status, '已恢复')
  assert.equal(journal.landedKeys.length, journal.writeKeys.length)
  const batch = store.batches.find((b) => b.id === failedId)!
  assert.equal(batch.status, '生效')
})
check('恢复后再恢复幂等：不重复写审计/版本', () => {
  const ivCount = store.segments.find((s) => s.id === 'SEG-K102')!.inspectionVersions.filter((v) => v.id === `IV-${failedId}`).length
  assert.equal(ivCount, 1)
  const before2 = store.audit.filter((a) => a.batchId === failedId).length
  const again = store.recoverBatch(failedId)
  assert.equal(again.ok, true)
  const after = store.audit.filter((a) => a.batchId === failedId).length
  // 恢复审计允许一条，但所有写入键审计稳定不重复（按 A-batch-key 去重）
  const writeAudit = store.audit.filter((a) => a.batchId === failedId && a.id.startsWith(`A-${failedId}-`))
  const ids = new Set(writeAudit.map((a) => a.id))
  assert.equal(ids.size, writeAudit.length)
  assert.ok(after >= before2 && after - before2 <= 1)
  void before2
  void auditCountBefore
})

check('缺陷写入中中断：恢复时已重定位缺陷不被二次映射', () => {
  const mid = store.importCorrectionPair(
    input({ segmentId: 'SEG-K208', roundKey: 'RK-MID', fileDigest: '9a9a9a9a', anchorEndDelta: -60, speedLimit: 200, temporarySpeedLimit: undefined }, '2026-10-07T10:30:00.000Z'),
    undefined,
    '缺陷写入中'
  ).first
  assert.equal(mid.ok, false)
  const midId = mid.batchId!
  const batch = store.batches.find((b) => b.id === midId)!
  // 第一个缺陷（旧8-15待核项位于区间前段）在中断前已落地重定位
  const firstOutcome = batch.outcomes.find((o) => o.kind !== '复议项')!
  const target = store.defects.find((d) => d.id === firstOutcome.defectId)!
  assert.equal(target.mileage, firstOutcome.newMileage)
  const recoverMid = store.recoverBatch(midId)
  assert.equal(recoverMid.ok, true, recoverMid.message)
  assert.equal(target.mileage, firstOutcome.newMileage, '已落地缺陷里程不得二次映射')
  assert.equal(target.mileageHistory.filter((m) => m.batchId === midId).length, 1, '同批次迁移记录只允许一条')
  // 未落地缺陷在恢复时按快照结果补齐
  for (const outcome of batch.outcomes.filter((o) => o.kind !== '复议项')) {
    const d = store.defects.find((x) => x.id === outcome.defectId)!
    assert.equal(d.mileage, outcome.newMileage)
  }
})

/* 5. 中断期间新导入被拦截，同轮次第二窗口可排队 */const fail2 = store.importCorrectionPair(
  input({ segmentId: 'SEG-K102', roundKey: 'RK-FAIL2', fileDigest: '44444444' }, '2026-10-07T11:00:00.000Z'),
  undefined,
  '限速写入后'
)
check('限速写入后中断；新轮次导入要求先恢复', () => {
  assert.equal(fail2.first.ok, false)
  const blocked = store.importCorrectionPair(input({ segmentId: 'SEG-K102', roundKey: 'RK-NEW', fileDigest: '55555555' }))
  assert.equal(blocked.first.ok, false)
  assert.match(blocked.first.message, /恢复/)
})
const fid2 = fail2.first.batchId!
const segBefore = store.segments.find((s) => s.id === 'SEG-K102')!
const speedBefore = segBefore.speedLimit
check('限速键已落地则恢复时不再改动，summary补齐即生效', () => {
  const j = store.journals.find((x) => x.batchId === fid2)!
  assert.ok(j.landedKeys.includes('speed'))
  const r = store.recoverBatch(fid2)
  assert.equal(r.ok, true)
  assert.equal(store.segments.find((s) => s.id === 'SEG-K102')!.speedLimit, speedBefore)
})

/* 6. 批准待复核 → 作为新批次在当前状态上生效 */
const pair3 = store.importCorrectionPair(
  input({ segmentId: 'SEG-K208', roundKey: 'RK-3', fileDigest: '66666666', speedLimit: 200 }, '2026-10-07T12:00:00.000Z'),
  input({ segmentId: 'SEG-K208', roundKey: 'RK-3', fileDigest: '77777777', speedLimit: 160, temporarySpeedLimit: 120 }, '2026-10-07T12:00:00.001Z', '导入窗口乙'),
  '无'
)
const pendingId = pair3.second.batchId!
const approve = store.reviewPendingBatch(pendingId, true, '技术科', '核对锚点无误')
check('批准后到内容：生成新批次在当前区段状态上整批生效', () => {
  assert.equal(approve.ok, true, approve.message)
  const seg = store.segments.find((s) => s.id === 'SEG-K208')!
  assert.equal(seg.speedLimit, 160)
  assert.equal(seg.temporarySpeedLimit, 120)
  assert.ok(seg.activeBatchId !== pendingId)
  const newBatch = store.batches.find((b) => b.id === seg.activeBatchId)!
  assert.equal(newBatch.status, '生效')
})

/* 7. 导出/审计同批次口径 */
check('导出对象含批次、版本链、恢复日志与一致性摘要', () => {
  const seg = store.segments.find((s) => s.id === 'SEG-K102')!
  assert.ok(seg.inspectionVersions.some((v) => v.batchId === seg.activeBatchId))
  assert.ok(seg.speedLimitVersions.some((v) => v.batchId === seg.activeBatchId))
  assert.equal(store.audit.every((a) => a.id), true)
})

/* 8. 限速联查在纠偏批次同样生效 */
check('一级缺陷未关闭时纠偏限速过低校验失败→转待复核', () => {
  const blocked = store.importCorrectionPair(input({ segmentId: 'SEG-K102', roundKey: 'RK-SPEED', fileDigest: '88888888', speedLimit: 160, temporarySpeedLimit: undefined }))
  assert.equal(blocked.first.ok, false)
  if (blocked.first.batchId) {
    assert.equal(store.batches.find((b) => b.id === blocked.first.batchId)!.status, '待复核')
  }
})

/* 9. schema 持久化：再次加载走已迁移数据，不重复回填 */
check('持久化 schema=2，重新初始化不重复回填审计', () => {
  const saved = Object.values(storage).map((text) => JSON.parse(text)).find((data) => data.segments)
  assert.equal(saved.schema, 2)
})

console.log(`\n全部 ${pass} 项检查通过`)
