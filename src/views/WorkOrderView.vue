<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const reconsideration = computed(() => store.reconsiderations.find((item) => item.defectId === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
function addAction() {
  if (!defect.value || !action.note) return
  store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  action.note = ''
}
function addRetest() {
  if (!defect.value) return
  // 轮次全局递增（失效轮次保留记录），合格判定只看有效轮次
  const round = defect.value.retests.reduce((max, item) => Math.max(max, item.round), 0) + 1
  const passed = retest.measuredValue <= defect.value.limit
  store.addRetest(defect.value.id, { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString() })
  message.value = passed ? '复测通过，缺陷已关闭并保留关闭依据' : '复测不合格，任务重新进入整治'
}
function closeDefect() {
  if (!defect.value) return
  const result = store.transition(defect.value.id, '已关闭')
  message.value = result.message
}
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong><small>{{ item.owner }} · {{ item.status }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head"><div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div>
          <div class="head-side">
            <v-chip size="small" :color="defect.versionConfidence === '待核' ? 'warning' : 'default'">{{ defect.versionConfidence === '待核' ? '检测版本待核' : defect.inspectionVersionId }}</v-chip>
            <v-chip :color="defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip>
          </div>
        </div>
        <div v-if="defect.retests.some((r) => r.invalidatedAt)" class="stale-band"><strong>复测结论因里程纠偏失效</strong><span>历史复测点位绑定旧里程，结论已失效，请整治后在新里程 K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }} 重新复测。</span></div>
        <div v-if="defect.closedBasis" class="basis-band">
          <strong>关闭时依据（随纠偏保留）</strong>
          <span>关闭里程 K{{ Math.floor(defect.closedBasis.mileage / 1000) }}+{{ String(defect.closedBasis.mileage % 1000).padStart(3, '0') }} · 第{{ defect.closedBasis.retestRound }}轮 {{ defect.closedBasis.measuredValue }}/{{ defect.closedBasis.limit }} · {{ defect.closedBasis.tester }} · {{ defect.closedBasis.testedAt.replace('T', ' ').slice(0, 16) }}</span>
        </div>
        <div v-if="reconsideration" class="basis-band" :class="{ reopened: reconsideration.status !== '待复议' }">
          <strong>复议项 · {{ reconsideration.status }}</strong>
          <span>纠偏新里程 K{{ Math.floor(reconsideration.newMileage / 1000) }}+{{ String(reconsideration.newMileage % 1000).padStart(3, '0') }}（{{ reconsideration.delta > 0 ? '+' : '' }}{{ reconsideration.delta }} 米）· 批次 {{ reconsideration.batchId }}<template v-if="reconsideration.resolutionNote"> · {{ reconsideration.resolutionNote }}</template></span>
        </div>
        <div class="offline-band"><strong>离线补录模式</strong><span>现场无网络时先写入本地队列，恢复后保留原始记录时间和复测轮次；纠偏批次统一接入。</span></div>
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
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div></div>
          <div>
            <h3>复测轮次</h3>
            <div v-for="item in defect.retests" :key="`${item.round}-${item.testedAt}`" :class="['record-item', { invalid: item.invalidatedAt }]">
              <strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}<v-chip v-if="item.invalidatedAt" size="x-small" color="warning">已失效</v-chip></strong>
              <span>{{ item.measuredValue }} / {{ item.limit }}</span>
              <small>{{ item.tester }} · {{ item.note }}</small>
              <small v-if="item.invalidReason" class="invalid-reason">{{ item.invalidReason }}（批次 {{ item.invalidatedByBatchId }}）</small>
            </div>
            <h3>里程变更轨迹</h3>
            <div v-for="(entry, index) in defect.mileageHistory" :key="index" class="record-item">
              <strong>{{ entry.batchId }}</strong>
              <span>K{{ Math.floor(entry.from / 1000) }}+{{ String(entry.from % 1000).padStart(3, '0') }} → K{{ Math.floor(entry.to / 1000) }}+{{ String(entry.to % 1000).padStart(3, '0') }}（{{ entry.delta > 0 ? '+' : '' }}{{ entry.delta }} 米）</span>
            </div>
            <small v-if="!defect.mileageHistory.length" class="muted">暂无纠偏重定位记录</small>
          </div>
        </div>
        <v-btn variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #738180; font-size: 11px; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.offline-band { display: flex; justify-content: space-between; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band span { color: #736d5b; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.record-item.invalid { opacity: .75; background: repeating-linear-gradient(45deg, #fdf8ee, #fdf8ee 6px, #fbf3e1 6px, #fbf3e1 12px); padding-left: 8px; }
.invalid-reason { color: #b18b38 !important; }
.muted { color: #98a3a3; font-size: 11px; }
.head-side { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.stale-band { display: flex; flex-direction: column; gap: 3px; padding: 11px; border-left: 3px solid #b18b38; background: #fbf3e1; font-size: 12px; margin-bottom: 10px; }
.stale-band span { color: #7d6a3d; }
.basis-band { display: flex; flex-direction: column; gap: 3px; padding: 11px; border-left: 3px solid #43876b; background: #eef7f1; font-size: 12px; margin-bottom: 10px; }
.basis-band span { color: #47665a; }
.basis-band.reopened { border-left-color: #315b72; background: #eef3f7; }
</style>
