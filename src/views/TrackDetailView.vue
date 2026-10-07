<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import MileageCanvas from '../components/MileageCanvas.vue'
import { useTrackStore } from '../stores/track'
import { windowKeyOf } from '../services/correction'
import type { CorrectionBatch } from '../types'

const store = useTrackStore()
const speed = ref(store.selectedSegment?.speedLimit ?? 160)
const temporary = ref<number | undefined>(store.selectedSegment?.temporarySpeedLimit)
const message = ref('')
const messageType = ref<'ok' | 'err'>('ok')

const segmentDefects = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentBatches = computed(() => store.batches.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentVersions = computed(() => store.inspectionVersions.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentReconsiderations = computed(() => store.reconsiderations.filter((item) => item.segmentId === store.selectedSegmentId))
const activeBatch = computed<CorrectionBatch | null>(() => segmentBatches.value.find((item) => item.id === store.selectedSegment?.activeBatchId) ?? segmentBatches.value.find((item) => item.status === '生效') ?? null)
const pendingBatches = computed(() => segmentBatches.value.filter((item) => item.status === '待复核'))
const failedBatches = computed(() => segmentBatches.value.filter((item) => item.status === '写入失败'))

const today = new Date().toISOString().slice(0, 10)
const form = reactive({
  measuredAt: `${today}T09:30:00`,
  detector: 'GJ-6型轨检车',
  fileDigest: '',
  offset: 0,
  speedLimit: 160,
  applySpeed: false,
  temporarySpeedLimit: undefined as number | undefined,
  note: ''
})
const failOps = [
  { title: '不注入失败', value: '' },
  { title: '检测数据版本', value: 'iv' },
  { title: '采样点里程', value: 'measurements' },
  { title: '区段里程', value: 'segment-stamp' },
  { title: '区段限速版本', value: 'speed' },
  { title: '缺陷重定位', value: 'relocate:' },
  { title: '关闭缺陷复议', value: 'reconsider:' },
  { title: '审计留痕', value: 'audit:' }
]
const failAt = ref('')

watch(() => store.selectedSegmentId, () => {
  speed.value = store.selectedSegment?.speedLimit ?? 160
  temporary.value = store.selectedSegment?.temporarySpeedLimit
  form.speedLimit = store.selectedSegment?.speedLimit ?? 160
  form.temporarySpeedLimit = store.selectedSegment?.temporarySpeedLimit
})

function announce(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageType.value = result.ok ? 'ok' : 'err'
}

function importCorrection() {
  if (!store.selectedSegment) return
  store.setFailureInjection(failAt.value || null)
  const result = store.importCorrection({
    segmentId: store.selectedSegmentId,
    measuredAt: form.measuredAt,
    detector: form.detector,
    fileDigest: form.fileDigest.trim() || undefined,
    windowKey: windowKeyOf(store.selectedSegmentId, form.measuredAt),
    offset: form.offset,
    speedLimit: form.applySpeed ? form.speedLimit : undefined,
    temporarySpeedLimit: form.applySpeed ? form.temporarySpeedLimit : undefined,
    note: form.note
  }, '轨检车补测')
  if (result.ok && store.selectedSegment) {
    speed.value = store.selectedSegment.speedLimit
    temporary.value = store.selectedSegment.temporarySpeedLimit
  }
  announce(result)
  failAt.value = ''
}

function selectSegment(id: string) {
  store.selectedSegmentId = id
}
function saveSpeed() {
  announce(store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value))
}
function retryBatch(id: string) { announce(store.retryBatch(id)) }
function approveBatch(id: string) { announce(store.approveBatch(id)) }
function rejectBatch(id: string) { announce(store.rejectBatch(id)) }
function maintain(itemId: string) { announce(store.resolveReconsideration(itemId, '维持关闭')) }
function reopen(itemId: string) { announce(store.resolveReconsideration(itemId, '重新立项')) }

function batchProgress(batch: CorrectionBatch): string {
  return `${batch.landedOps.length}/${batch.plan.allOps.length}`
}
function mileageLabel(value: number) {
  return `K${Math.floor(value / 1000)}+${String(value % 1000).padStart(3, '0')}`
}
const statusColor: Record<string, string> = { 生效: 'success', 待复核: 'warning', 写入失败: 'error', 作废: 'default' }
const reviewColor: Record<string, string> = { 待复议: 'warning', 维持关闭: 'success', 重新立项: 'info', 随批次作废: 'default' }
</script>

<template>
  <section class="page">
    <div class="split">
      <div class="segment-list">
        <button v-for="segment in store.segments" :key="segment.id" :class="{ active: segment.id === store.selectedSegmentId }" @click="selectSegment(segment.id)">
          <span>{{ segment.id }} · V{{ segment.version }} · {{ segment.measurements.length }}点</span><strong>{{ segment.line }}</strong>
          <small>{{ mileageLabel(segment.startMileage) }} - {{ mileageLabel(segment.endMileage) }}</small>
          <small v-if="segment.activeBatchId" class="batch-tag">生效批次 {{ segment.activeBatchId }}</small>
        </button>
      </div>
      <div v-if="store.selectedSegment" class="track-main">
        <div class="section-head">
          <div><span>{{ store.selectedSegment.id }}</span><h2>{{ store.selectedSegment.line }}</h2>
            <p>正式限速 {{ store.selectedSegment.speedLimit }} km/h<template v-if="store.selectedSegment.temporarySpeedLimit"> · 临时限速 {{ store.selectedSegment.temporarySpeedLimit }} km/h</template></p>
          </div>
          <div class="head-chips">
            <v-chip color="warning">限速版本 V{{ store.selectedSegment.version }}</v-chip>
            <v-chip :color="activeBatch ? 'success' : 'default'">{{ activeBatch ? `纠偏批次 ${activeBatch.id}` : '尚无纠偏批次' }}</v-chip>
          </div>
        </div>

        <div v-if="message" :class="['validation-message', messageType]">{{ message }}</div>

        <MileageCanvas :segment="store.selectedSegment" :defects="segmentDefects" :reconsiderations="segmentReconsiderations" :active-batch="activeBatch" />

        <div class="import-panel">
          <div class="panel-title"><strong>导入轨检车补测纠偏结果</strong><span>检测数据版本、缺陷重定位、复测结论重算与区段限速版本接入同一纠偏批次</span></div>
          <div class="import-grid">
            <v-text-field v-model="form.measuredAt" type="datetime-local" label="补测时间（决定导入窗口）" density="compact" variant="outlined" hide-details />
            <v-select v-model="form.detector" :items="['GJ-6型轨检车', '便携式激光测量仪']" label="检测设备" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="form.fileDigest" label="文件摘要（留空按修正结果生成）" density="compact" variant="outlined" hide-details placeholder="如 A1B2C3D4" />
            <v-text-field v-model.number="form.offset" type="number" label="里程整体平移量（米）" density="compact" variant="outlined" hide-details />
            <v-checkbox v-model="form.applySpeed" label="本批同时调整限速" density="compact" hide-details color="primary" />
            <v-text-field v-model.number="form.speedLimit" :disabled="!form.applySpeed" type="number" label="纠偏后正式限速" density="compact" variant="outlined" hide-details suffix="km/h" />
            <v-text-field v-model.number="form.temporarySpeedLimit" :disabled="!form.applySpeed" type="number" label="纠偏后临时限速" density="compact" variant="outlined" hide-details suffix="km/h" />
            <v-text-field v-model="form.note" label="纠偏说明" density="compact" variant="outlined" hide-details />
            <v-select v-model="failAt" :items="failOps" label="写入失败注入（演示恢复）" density="compact" variant="outlined" hide-details />
            <v-btn color="primary" @click="importCorrection">导入并接入纠偏批次</v-btn>
          </div>
          <p class="panel-hint">同区段同补测日期为同一导入窗口：两个窗口同时导入时先到版本生效，后到内容完整保留待复核。</p>
        </div>

        <div class="batch-block">
          <div class="panel-title"><strong>纠偏批次（页面 / 里程图 / 审计 / 导出同一批次）</strong>
            <span>生效 {{ segmentBatches.filter((b) => b.status === '生效').length }} · 待复核 {{ pendingBatches.length }} · 失败 {{ failedBatches.length }}</span>
          </div>
          <v-table density="compact">
            <thead><tr><th>批次</th><th>窗口/补测时间</th><th>文件摘要</th><th>平移</th><th>检测版本 / 限速</th><th>落地进度</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="batch in segmentBatches" :key="batch.id">
                <td><strong>{{ batch.id }}</strong><br /><small v-if="batch.supersededBatchId">关联先到批次 {{ batch.supersededBatchId }}</small></td>
                <td>{{ batch.windowKey }}<br /><small>{{ batch.measuredAt.replace('T', ' ').slice(0, 16) }}</small></td>
                <td><code>{{ batch.fileDigest }}</code></td>
                <td>{{ batch.payload.offset > 0 ? '+' : '' }}{{ batch.payload.offset }} 米</td>
                <td><small>{{ batch.plan.inspectionVersion?.id }}<br />限速 V{{ batch.plan.speedVersion.version }}</small></td>
                <td>
                  {{ batchProgress(batch) }}
                  <v-progress-linear v-if="batch.status === '写入失败'" :model-value="batch.landedOps.length / batch.plan.allOps.length * 100" color="error" height="6" />
                </td>
                <td>
                  <v-chip size="small" :color="statusColor[batch.status]">{{ batch.status }}</v-chip>
                  <small v-if="batch.failureReason" class="fail-reason">{{ batch.failureReason }}</small>
                </td>
                <td>
                  <v-btn v-if="batch.status === '写入失败'" size="x-small" color="error" variant="outlined" @click="retryBatch(batch.id)">从完整批次恢复重试</v-btn>
                  <template v-if="batch.status === '待复核'">
                    <v-btn size="x-small" color="success" variant="outlined" @click="approveBatch(batch.id)">确认生效</v-btn>
                    <v-btn size="x-small" variant="text" @click="rejectBatch(batch.id)">作废保留</v-btn>
                  </template>
                  <v-btn v-if="batch.status !== '生效' && batch.status !== '作废'" size="x-small" variant="text" @click="rejectBatch(batch.id)">作废</v-btn>
                </td>
              </tr>
              <tr v-if="!segmentBatches.length"><td colspan="8" class="empty-row">暂无纠偏批次</td></tr>
            </tbody>
          </v-table>
        </div>

        <div class="two-panels">
          <div class="mini-panel">
            <div class="panel-title"><strong>检测数据版本</strong><span>旧数据按测量时间与文件摘要回填</span></div>
            <v-table density="compact">
              <thead><tr><th>版本</th><th>测量时间</th><th>摘要</th><th>采样点</th><th>来源批次</th></tr></thead>
              <tbody>
                <tr v-for="iv in segmentVersions" :key="iv.id">
                  <td><small>{{ iv.id }}</small></td>
                  <td>{{ iv.measuredAt.replace('T', ' ').slice(0, 16) }}</td>
                  <td><code>{{ iv.fileDigest }}</code></td>
                  <td>{{ iv.measurementIds.length }}</td>
                  <td><v-chip size="small" :color="iv.batchId ? 'success' : 'default'">{{ iv.batchId ?? '回填待核' }}</v-chip></td>
                </tr>
              </tbody>
            </v-table>
          </div>
          <div class="mini-panel">
            <div class="panel-title"><strong>已关闭缺陷复议项</strong><span>关闭依据保留，按纠偏后里程复议</span></div>
            <v-table density="compact">
              <thead><tr><th>缺陷</th><th>关闭里程 → 新里程</th><th>批次</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="item in segmentReconsiderations" :key="item.id">
                  <td>{{ item.defectId }}</td>
                  <td>{{ mileageLabel(item.closedMileage) }} → {{ mileageLabel(item.newMileage) }}</td>
                  <td><small>{{ item.batchId }}</small></td>
                  <td><v-chip size="small" :color="reviewColor[item.status]">{{ item.status }}</v-chip></td>
                  <td>
                    <template v-if="item.status === '待复议'">
                      <v-btn size="x-small" variant="outlined" @click="maintain(item.id)">维持关闭</v-btn>
                      <v-btn size="x-small" color="warning" variant="text" @click="reopen(item.id)">重新立项</v-btn>
                    </template>
                    <small v-else>{{ item.resolvedBy }} · {{ item.resolutionNote }}</small>
                  </td>
                </tr>
                <tr v-if="!segmentReconsiderations.length"><td colspan="5" class="empty-row">暂无复议项</td></tr>
              </tbody>
            </v-table>
          </div>
        </div>

        <div class="speed-panel">
          <div><strong>速度与限速联查（手工调整不绑定纠偏批次）</strong><p>纠偏批次内的限速调整走上方导入；一级缺陷未关闭时临时限速必须低于正式限速。</p></div>
          <v-text-field v-model.number="speed" label="正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="temporary" label="临时限速" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
          <v-btn color="primary" @click="saveSpeed">保存速度版本</v-btn>
        </div>
        <v-table density="compact">
          <thead><tr><th>关联缺陷</th><th>里程</th><th>类型</th><th>严重度</th><th>检测版本</th><th>状态</th></tr></thead>
          <tbody><tr v-for="item in segmentDefects" :key="item.id">
            <td>{{ item.id }}</td><td>{{ mileageLabel(item.mileage) }}</td><td>{{ item.type }}</td><td>{{ item.severity }}</td>
            <td><v-chip size="small" :color="item.versionConfidence === '待核' ? 'warning' : 'default'">{{ item.versionConfidence === '待核' ? '待核' : item.inspectionVersionId }}</v-chip></td>
            <td>
              <v-chip size="small" :color="item.status === '已关闭' ? 'success' : item.status === '复测不合格' ? 'error' : 'warning'">{{ item.status }}</v-chip>
              <small v-if="item.retests.some((r) => r.invalidatedAt)" class="stale-tag">复测已失效待重算</small>
            </td>
          </tr></tbody>
        </v-table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.segment-list { display: grid; gap: 8px; }
.segment-list button { background: white; border: 1px solid #dae1e2; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; border-radius: 4px; }
.segment-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.segment-list span, .segment-list small { color: #748180; font-size: 11px; }
.batch-tag { color: #8c6a2f !important; font-weight: 600; }
.track-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.head-chips { display: flex; gap: 6px; align-items: flex-start; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }
.section-head span { color: #738180; font-size: 11px; }.section-head h2 { margin: 4px 0; font-size: 20px; }.section-head p { margin: 0; color: #60706f; }
.import-panel { border: 1px solid #e0d3ac; background: #fdfaf1; padding: 13px; margin-top: 14px; }
.panel-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.panel-title strong { font-size: 14px; } .panel-title span { color: #8a8471; font-size: 11px; }
.import-grid { display: grid; grid-template-columns: repeat(3, 1fr) auto; gap: 10px; align-items: center; }
.panel-hint { margin: 8px 0 0; color: #8a7f5f; font-size: 11px; }
.batch-block { margin-top: 16px; }
.fail-reason { display: block; color: #a33a35; font-size: 10px; margin-top: 3px; }
.two-panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
.mini-panel { border: 1px solid #e3e8e9; padding: 10px; }
.empty-row { text-align: center; color: #98a3a2; font-size: 12px; padding: 12px !important; }
.speed-panel { display: grid; grid-template-columns: 1fr 130px 130px auto; gap: 10px; align-items: center; margin: 16px 0; padding: 12px; background: #f4f7f7; }
.speed-panel p { margin: 4px 0 0; color: #71807f; font-size: 11px; }
.validation-message { font-size: 12px; margin-bottom: 10px; padding: 8px 10px; border-radius: 3px; }
.validation-message.ok { color: #2f6b4f; background: #eef7f1; }
.validation-message.err { color: #a33a35; background: #fbf0ef; }
.stale-tag { color: #b18b38; margin-left: 6px; }
code { font-size: 10px; color: #315b72; }
</style>
