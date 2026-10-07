// 临时冒烟测试：纠偏批次并发窗口、失败恢复、回填迁移
import { createPinia, setActivePinia } from 'pinia'
import assert from 'node:assert'

const storage = {}
globalThis.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = v },
  removeItem: (k) => { delete storage[k] }
}
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v))

setActivePinia(createPinia())
const { useTrackStore } = await import('../src/stores/track.ts')
const { windowKeyOf } = await import('../src/services/correction.ts')

function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`) } catch (e) { console.error(`FAIL  ${name}\n  ${e.message}`); process.exitCode = 1 }
}

// 1) 初始种子：待核缺陷与已确认缺陷
{
  const store = useTrackStore()
  check('种子：25-26日检测批次的29日缺陷待核', () => {
    const d1 = store.defects.find((d) => d.id === 'GD-260929-01')
    assert.equal(d1.versionConfidence, '待核')
    const d3 = store.defects.find((d) => d.id === 'GD-260928-07')
    assert.equal(d3.versionConfidence, '已确认')
    assert.ok(d3.closedBasis, '已关闭缺陷有当时依据')
  })
}

// 2) 同窗口两批导入：先到生效，后到待复核
{
  const store = useTrackStore()
  const seg = 'SEG-K102'
  const day = '2026-10-07T10:00:00'
  const w = windowKeyOf(seg, day)
  const r1 = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: w, offset: 12, note: '窗口A' }, '导入端A')
  assert.ok(r1.ok, r1.message)
  const firstId = r1.batchId
  const r2 = store.importCorrection({ segmentId: seg, measuredAt: '2026-10-07T11:30:00', detector: 'GJ-6型轨检车', fileDigest: 'DEADBEEF', windowKey: w, offset: 35, note: '窗口B' }, '导入端B')
  assert.ok(r2.ok, r2.message)
  check('同窗口先到生效/后到待复核且内容保留', () => {
    assert.equal(store.batches.find((b) => b.id === firstId).status, '生效')
    const second = store.batches.find((b) => b.id === r2.batchId)
    assert.equal(second.status, '待复核')
    assert.equal(second.payload.offset, 35)
    assert.equal(second.supersededBatchId, firstId)
    // 后到内容未改动当前里程
    const d = store.defects.find((x) => x.id === 'GD-260929-01')
    assert.equal(d.mileage, 102812)
  })

  // 批准后到批次：取代先生效批次，缺陷重定位到 +35，复测失效，待核确认
  const ar = store.approveBatch(r2.batchId)
  check('复核生效：取代前批、缺陷重定位、复测失效、待核转确认', () => {
    assert.ok(ar.ok, ar.message)
    assert.equal(store.batches.find((b) => b.id === firstId).status, '作废')
    assert.equal(store.batches.find((b) => b.id === r2.batchId).status, '生效')
    const d1 = store.defects.find((x) => x.id === 'GD-260929-01')
    assert.equal(d1.mileage, 102835)
    assert.equal(d1.versionConfidence, '已确认')
    assert.ok(d1.mileageHistory.length >= 1)
    const d2 = store.defects.find((x) => x.id === 'GD-260929-02')
    assert.equal(d2.mileage, 103435)
    assert.ok(d2.retests[0].invalidatedAt, '历史复测失效')
    assert.equal(d2.status, '待复测', '结论重算后回待复测')
  })
}

// 3) 写入失败注入 + 恢复：重试只落地未落地对象
{
  const store = useTrackStore()
  store.setFailureInjection('speed')
  const seg = 'SEG-K208'
  const day = '2026-10-08T09:00:00'
  const r = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: windowKeyOf(seg, day), offset: -20, note: 'K208纠偏' }, '导入端C')
  check('失败：批次保留、已落地对象可追踪、版本不重复改动', () => {
    assert.ok(!r.ok, '应失败')
    const batch = store.batches.find((b) => b.id === r.batchId)
    assert.equal(batch.status, '写入失败')
    assert.deepEqual(batch.landedOps, ['iv', 'measurements', 'segment-stamp'])
    assert.equal(batch.failedOp, 'speed')
    // 采样点里程已落地
    const p = store.segments.find((s) => s.id === seg).measurements[0]
    assert.equal(p.mileage, 207980)
    // 限速未改动
    assert.equal(store.segments.find((s) => s.id === seg).version, 3)
    // 检测版本已写入
    assert.ok(store.inspectionVersions.some((iv) => iv.batchId === batch.id))
  })
  const rr = store.retryBatch(r.batchId)
  check('恢复：重试成功且只处理未落地对象', () => {
    assert.ok(rr.ok, rr.message)
    const batch = store.batches.find((b) => b.id === r.batchId)
    assert.equal(batch.status, '生效')
    assert.equal(store.segments.find((s) => s.id === seg).version, 4)
    // 已关闭缺陷生成复议项
    const rc = store.reconsiderations.find((x) => x.batchId === batch.id)
    assert.ok(rc, '已关闭缺陷列入复议')
    assert.equal(rc.newMileage, 209180)
    // 已关闭缺陷里程与依据保持
    const closed = store.defects.find((d) => d.id === 'GD-260928-07')
    assert.equal(closed.mileage, 209200)
    assert.equal(closed.status, '已关闭')
    assert.ok(closed.closedBasis)
  })
  // 幂等：再次重试不改动
  const again = store.retryBatch(r.batchId)
  check('已生效批次不重复改动', () => assert.ok(!again.ok))
}

// 4) 复议处理（独立窗口 + 独立 store，避免与场景3同日）
{
  setActivePinia(createPinia())
  const store = useTrackStore()
  const seg = 'SEG-K208'
  const day = '2026-10-10T14:00:00'
  const r = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: windowKeyOf(seg, day), offset: -20, note: '复议演示' }, '导入端D')
  assert.ok(r.ok, r.message)
  const rc = store.reconsiderations.find((x) => x.batchId === r.batchId)
  const res = store.resolveReconsideration(rc.id, '重新立项', '调度', '复核后按新里程处理')
  check('复议重新立项：里程更新、合格复测失效、状态待复测、依据保留', () => {
    assert.ok(res.ok)
    const d = store.defects.find((x) => x.id === 'GD-260928-07')
    assert.equal(d.mileage, 209180)
    assert.equal(d.status, '待复测')
    assert.ok(d.retests[0].invalidatedAt)
    assert.ok(d.closedBasis, '关闭依据仍保留')
    assert.equal(rc.status, '重新立项')
  })
}

// 5) v1 旧数据迁移回填
{
  const v1 = JSON.stringify({
    segments: [{ id: 'SEG-K102', line: '京广上行 K102', startMileage: 102000, endMileage: 104800, speedLimit: 160, version: 1,
      measurements: [
        { id: 'X1', mileage: 102000, gauge: 1435, level: 1, alignment: 1, twist: 1, measuredAt: '2026-09-01T01:00:00', detector: 'GJ-6型轨检车' },
        { id: 'X2', mileage: 102200, gauge: 1435, level: 1, alignment: 1, twist: 1, measuredAt: '2026-09-01T02:00:00', detector: 'GJ-6型轨检车' }
      ] }],
    defects: [{ id: 'OLD-1', segmentId: 'SEG-K102', mileage: 102200, type: '轨距', severity: '二级', measuredValue: 1450, limit: 1446, status: '待派工', owner: '工区', discoveredAt: '2026-09-01T03:00:00', dueDate: '2026-09-02', actions: [], retests: [], version: 1 }],
    audit: []
  })
  storage['gsb66:track-geometry'] = v1
  setActivePinia(createPinia())
  const store = useTrackStore()
  check('v1迁移：检测版本回填、24小时内缺陷确认、限速历史补齐', () => {
    assert.equal(store.inspectionVersions.length, 1)
    assert.ok(store.inspectionVersions[0].fileDigest.length === 8)
    assert.equal(store.defects[0].versionConfidence, '已确认')
    assert.equal(store.defects[0].inspectionVersionId, store.inspectionVersions[0].id)
    assert.equal(store.segments[0].speedLimitHistory.length, 1)
  })
  // 超出窗口的缺陷待核
  storage['gsb66:track-geometry'] = JSON.stringify({ ...JSON.parse(v1), defects: [{ ...JSON.parse(v1).defects[0], id: 'OLD-2', discoveredAt: '2026-09-10T00:00:00' }] })
  setActivePinia(createPinia())
  const store2 = useTrackStore()
  check('v1迁移：无法确认测量时间的缺陷先待核', () => assert.equal(store2.defects[0].versionConfidence, '待核'))
}

function resetStore() {
  storage['gsb66:track-geometry'] = null
  setActivePinia(createPinia())
  return useTrackStore()
}

// 6) 重复文件摘要拒绝
{
  const store = resetStore()
  const seg = 'SEG-K102'
  const payload = { segmentId: seg, measuredAt: '2026-10-09T09:00:00', detector: 'GJ-6型轨检车', fileDigest: 'SAMEFILE', windowKey: windowKeyOf(seg, '2026-10-09T09:00:00'), offset: 5, note: '重复' }
  const r1 = store.importCorrection(payload, '端A')
  const r2 = store.importCorrection({ ...payload, measuredAt: '2026-10-10T09:00:00', windowKey: windowKeyOf(seg, '2026-10-10T09:00:00') }, '端B')
  check('同摘要重复导入被拒绝', () => { assert.ok(r1.ok); assert.ok(!r2.ok); assert.match(r2.message, /已存在/) })
}

// 7) 页面/里程图/审计/导出同一批次：落地对象全部挂同一 batchId
{
  const store = resetStore()
  const seg = 'SEG-K102'
  const day = '2026-10-11T09:00:00'
  const r = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: windowKeyOf(seg, day), offset: 8, note: '一致性' }, '端E')
  check('批次同源：检测版本/限速/缺陷/审计全部带同一 batchId', () => {
    assert.ok(r.ok, r.message)
    const batchId = r.batchId
    // 检测版本挂批次
    assert.ok(store.inspectionVersions.some((iv) => iv.batchId === batchId))
    // 区段激活批次与限速历史挂批次
    const segment = store.segments.find((s) => s.id === seg)
    assert.equal(segment.activeBatchId, batchId)
    assert.ok(segment.speedLimitHistory.some((v) => v.batchId === batchId))
    // 未关闭缺陷里程历史挂批次
    for (const d of store.defects.filter((x) => x.segmentId === seg)) {
      assert.ok(d.mileageHistory.some((h) => h.batchId === batchId))
    }
    // 审计全部带批次且无重复
    const batchAudits = store.audit.filter((a) => a.batchId === batchId)
    assert.ok(batchAudits.length >= 5, `审计条目应>=5，实际 ${batchAudits.length}`)
    const keys = new Set(batchAudits.map((a) => `${a.entityId}|${a.action}`))
    assert.equal(keys.size, batchAudits.length, '审计无重复条目')
    // 导出报告包含批次（与 AuditView 导出结构一致）
    const exported = JSON.stringify({ batches: store.batches, inspectionVersions: store.inspectionVersions, audit: store.audit, reconsiderations: store.reconsiderations })
    assert.ok(exported.includes(batchId))
  })
}

// 8) 复测失效后重算：新里程复测合格可关闭；无效合格复测不能关闭
{
  const store = resetStore()
  const seg = 'SEG-K102'
  const day = '2026-10-12T09:00:00'
  const r = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: windowKeyOf(seg, day), offset: 10, note: '重算' }, '端F')
  assert.ok(r.ok, r.message)
  const d2 = store.defects.find((x) => x.id === 'GD-260929-02')
  check('失效复测不能用于关闭；新复测合格后关闭并记录依据', () => {
    assert.ok(d2.retests[0].invalidatedAt)
    // 没有有效合格复测，不能关闭
    const blocked = store.transition(d2.id, '已关闭')
    assert.ok(!blocked.ok)
    // 提交新复测（第1轮，因为历史轮次已失效）
    store.addRetest(d2.id, { round: 1, passed: true, measuredValue: 7.2, limit: 8.0, note: '纠偏后新里程复测合格', tester: '王磊', testedAt: new Date().toISOString() })
    assert.equal(d2.status, '已关闭')
    assert.ok(d2.closedBasis)
    assert.equal(d2.closedBasis.mileage, d2.mileage)
  })
}

// 9) 失败恢复幂等：二次重试不产生重复审计/版本
{
  const store = resetStore()
  store.setFailureInjection('audit:')
  const seg = 'SEG-K208'
  const day = '2026-10-13T09:00:00'
  const r = store.importCorrection({ segmentId: seg, measuredAt: day, detector: 'GJ-6型轨检车', windowKey: windowKeyOf(seg, day), offset: 5, note: '审计失败' }, '端G')
  const auditsBefore = store.audit.filter((a) => a.batchId === r.batchId).length
  const rr = store.retryBatch(r.batchId)
  check('审计阶段失败后恢复，不重复落地已写入对象', () => {
    assert.ok(!r.ok)
    assert.ok(rr.ok, rr.message)
    const batch = store.batches.find((b) => b.id === r.batchId)
    assert.equal(batch.status, '生效')
    // 限速版本只出现一次
    const seg2 = store.segments.find((s) => s.id === seg)
    assert.equal(seg2.speedLimitHistory.filter((v) => v.batchId === batch.id).length, 1)
    // 检测版本只出现一次
    assert.equal(store.inspectionVersions.filter((iv) => iv.batchId === batch.id).length, 1)
    // 恢复后审计完整且不重复（至少有一条审计是重试阶段补上的）
    const auditsAfter = store.audit.filter((a) => a.batchId === batch.id)
    assert.ok(auditsAfter.length > auditsBefore)
    const keys = new Set(auditsAfter.map((a) => `${a.entityId}|${a.action}`))
    assert.equal(keys.size, auditsAfter.length)
    assert.equal(batch.landedOps.length, new Set(batch.landedOps).size, 'landedOps 无重复')
  })
}
