<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'
import { formatKm } from '../domain/correction'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const segment = computed(() => store.segments.find((item) => item.id === defect.value?.segmentId))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
const latestMove = computed(() => defect.value?.mileageHistory[0])
function addAction() {
  if (!defect.value || !action.note) return
  store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  action.note = ''
}
function addRetest() {
  if (!defect.value) return
  const round = defect.value.retests.length + 1
  const passed = retest.measuredValue <= defect.value.limit
  store.addRetest(defect.value.id, { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString(), valid: true })
  message.value = passed ? '复测通过，缺陷已关闭' : '复测不合格，任务重新进入整治'
}
function closeDefect() {
  if (!defect.value) return
  const result = store.transition(defect.value.id, '已关闭')
  message.value = result.message
}
function inspectionLabel(id?: string) {
  return segment.value?.inspectionVersions.find((item) => item.id === id)
}
function reviewMileage(defectId: string, batchId: string) {
  const target = store.defects.find((item) => item.id === defectId)
  return store.batches.find((batch) => batch.id === batchId)?.outcomes.find((outcome) => outcome.defectId === defectId)?.newMileage ?? target?.mileage ?? 0
}
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong>
          <small>{{ item.owner }} · {{ item.status }}</small>
          <small v-if="item.inspectionVersionUnverified" class="pending-tag">检测版本待核</small>
          <small v-else-if="item.lastBatchId" class="batch-tag">{{ item.lastBatchId }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head">
          <div><span>{{ defect.segmentId }} · {{ formatKm(defect.mileage) }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div>
          <v-chip :color="defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip>
        </div>

        <div v-if="latestMove" class="correction-band">
          <strong>纠偏批次 {{ latestMove.batchId }} 已重新定位</strong>
          <span>{{ formatKm(latestMove.fromMileage) }} → {{ formatKm(latestMove.toMileage) }}（{{ latestMove.reason }}）；检测版本已重挂 {{ defect.inspectionVersionId }}，旧里程复测结论失效。</span>
        </div>
        <div v-if="defect.closedBasis" class="closed-band">
          <strong>关闭依据已归档{{ defect.closedBasis.reviewBatchIds.length ? ` · 复议项 ×${defect.closedBasis.reviewBatchIds.length}` : '' }}</strong>
          <span>关闭里程 {{ formatKm(defect.closedBasis.mileage) }} · 检测版本 {{ defect.closedBasis.inspectionVersionId }} · 限速版本 {{ defect.closedBasis.speedLimitVersionId }} · 关闭于 {{ defect.closedBasis.closedAt.replace('T', ' ').slice(0, 16) }}</span>
          <div v-for="batchId in defect.closedBasis.reviewBatchIds" :key="batchId" class="review-row">
            <v-chip size="x-small" color="secondary">复议项 {{ batchId }}</v-chip>
            <span>新位置建议 {{ formatKm(reviewMileage(defect.id, batchId)) }}；当时依据保留不覆盖，需人工复议。</span>
          </div>
        </div>

        <div class="offline-band"><strong>离线补录模式</strong><span>现场无网络时先写入本地队列，恢复后保留原始记录时间和复测轮次；纠偏批次写入中断时从完整检测批次恢复。</span></div>
        <template v-if="defect.status !== '已关闭'">
          <div class="action-form">
            <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
            <v-btn color="primary" :disabled="!action.note" @click="addAction">提交整治记录</v-btn>
          </div>
          <div class="action-form">
            <v-text-field v-model.number="retest.measuredValue" type="number" label="复测值" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
            <v-btn color="secondary" @click="addRetest">提交复测</v-btn>
          </div>
        </template>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div class="two-column">
          <div>
            <h3>整治记录</h3>
            <div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div>
          </div>
          <div>
            <h3>复测轮次</h3>
            <div v-for="item in defect.retests" :key="item.round" class="record-item" :class="{ invalid: !item.valid }">
              <strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }} <v-chip v-if="!item.valid" size="x-small" color="error">已失效</v-chip></strong>
              <span>{{ item.measuredValue }} / {{ item.limit }} · {{ formatKm(defect.mileage) }}</span>
              <small>{{ item.tester }} · {{ item.note }}</small>
              <small v-if="item.recomputed" class="recompute">↳ 批次{{ item.invalidatedByBatchId }}重算@{{ formatKm(item.recomputed.sampleMileage) }}：{{ item.recomputed.measuredValue }} / {{ item.limit }}，{{ item.recomputed.passed ? '重算合格' : '重算仍超限' }}</small>
            </div>
          </div>
        </div>
        <div class="version-line">
          <span>检测版本：<v-chip size="x-small" :color="defect.inspectionVersionUnverified ? 'error' : 'default'">{{ defect.inspectionVersionUnverified ? `待核（${defect.inspectionVersionId}）` : defect.inspectionVersionId }}</v-chip></span>
          <span v-if="inspectionLabel(defect.inspectionVersionId)">测量时间 {{ inspectionLabel(defect.inspectionVersionId)?.measuredAt.replace('T', ' ').slice(0, 16) }} · 摘要 {{ inspectionLabel(defect.inspectionVersionId)?.fileDigest ?? '无' }}</span>
        </div>
        <v-btn v-if="defect.status !== '已关闭'" variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #748180; font-size: 11px; }
.work-list .batch-tag { color: #8c6a2f; }.work-list .pending-tag { color: #b84239; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.correction-band { border-left: 3px solid #b18b38; background: #fbf6e9; padding: 11px 13px; margin-bottom: 10px; font-size: 12px; }.correction-band span { display: block; color: #75680f; margin-top: 4px; }
.closed-band { border-left: 3px solid #43876b; background: #eef6f1; padding: 11px 13px; margin-bottom: 10px; font-size: 12px; }.closed-band span { display: block; color: #4c6c5c; margin-top: 4px; }
.review-row { display: flex; gap: 8px; align-items: center; margin-top: 6px; color: #8c6a2f; }
.offline-band { display: flex; justify-content: space-between; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band span { color: #736d5b; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.record-item.invalid { opacity: .72; }.recompute { color: #b18b38; }
.version-line { display: flex; gap: 16px; align-items: center; font-size: 11px; color: #718080; margin-bottom: 12px; }
</style>
