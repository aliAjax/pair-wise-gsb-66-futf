<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import MileageCanvas from '../components/MileageCanvas.vue'
import { useTrackStore, type FailureInject } from '../stores/track'
import { formatKm } from '../domain/correction'

const store = useTrackStore()
const speed = ref(store.selectedSegment?.speedLimit ?? 160)
const temporary = ref<number | undefined>(store.selectedSegment?.temporarySpeedLimit)
const message = ref('')
const pairMessage = ref<{ first: string; second: string } | null>(null)
const segmentDefects = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentBatches = computed(() => store.batches.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentJournals = computed(() => store.journals.filter((item) => item.segmentId === store.selectedSegmentId))
const activeInspection = computed(() => store.selectedSegment?.inspectionVersions.find((item) => item.status === '生效'))

const form = reactive({
  windowName: '导入窗口甲',
  operator: '检测工区 赵鹏',
  fileTag: 'K102-补测-20261007.dat',
  fileDigest: '',
  anchorStartDelta: 0,
  anchorEndDelta: -80,
  speedLimit: store.selectedSegment?.speedLimit ?? 160,
  temporarySpeedLimit: (store.selectedSegment?.temporarySpeedLimit ?? 120) as number | undefined,
  failure: '无' as FailureInject,
  note: '轨检车补测，校正区间累计里程偏差'
})
const roundKey = ref(`RK-${Date.now()}`)
const reviewForm = reactive<Record<string, { reviewer: string; note: string }>>({})
function reviewState(id: string) {
  if (!reviewForm[id]) reviewForm[id] = { reviewer: '技术科 孙敏', note: '' }
  return reviewForm[id]
}

watch(() => store.selectedSegmentId, () => {
  speed.value = store.selectedSegment?.speedLimit ?? 160
  temporary.value = store.selectedSegment?.temporarySpeedLimit
  form.speedLimit = speed.value
  form.temporarySpeedLimit = temporary.value
  message.value = ''
  pairMessage.value = null
}, { immediate: false })

function regenerateDigest() {
  form.fileDigest = store.digestPreview(`${form.fileTag}|${store.selectedSegmentId}|${roundKey.value}`)
}
regenerateDigest()

function baseInput(windowName: string, fileDigest: string, importedAt: string) {
  return {
    segmentId: store.selectedSegmentId,
    roundKey: roundKey.value,
    windowName,
    operator: form.operator,
    importedAt,
    fileDigest,
    note: form.note,
    anchorStartDelta: form.anchorStartDelta,
    anchorEndDelta: form.anchorEndDelta,
    speedLimit: form.speedLimit,
    temporarySpeedLimit: form.temporarySpeedLimit
  }
}

function importSingle() {
  pairMessage.value = null
  const result = store.importCorrectionPair(baseInput(form.windowName, form.fileDigest, new Date().toISOString()), undefined, form.failure)
  message.value = result.first.message
  roundKey.value = `RK-${Date.now()}`
  regenerateDigest()
}

function importPair() {
  message.value = ''
  const stamp = Date.now()
  const first = baseInput('导入窗口甲', form.fileDigest, new Date(stamp).toISOString())
  const secondDigest = store.digestPreview(`${form.fileTag}|窗口乙|${roundKey.value}`)
  const second = baseInput('导入窗口乙', secondDigest, new Date(stamp + 1).toISOString())
  second.note = `${form.note}（第二窗口同轮次导入）`
  const result = store.importCorrectionPair(first, second, form.failure)
  pairMessage.value = { first: result.first.message, second: result.second.message }
  roundKey.value = `RK-${Date.now()}`
  regenerateDigest()
}

function recover(journalId: string) {
  const journal = segmentJournals.value.find((item) => item.id === journalId)
  if (!journal) return
  message.value = store.recoverBatch(journal.batchId).message
}

function approve(batchId: string) {
  const state = reviewState(batchId)
  message.value = store.reviewPendingBatch(batchId, true, state.reviewer, state.note).message
}
function reject(batchId: string) {
  const state = reviewState(batchId)
  message.value = store.reviewPendingBatch(batchId, false, state.reviewer, state.note).message
}

function saveSpeed() {
  const result = store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value)
  message.value = result.message
}

function outcomeSummary(batchId: string) {
  const batch = segmentBatches.value.find((item) => item.id === batchId)
  if (!batch) return ''
  const counts = { 重定位: 0, 复测失效重算: 0, 复议项: 0 }
  batch.outcomes.forEach((item) => { counts[item.kind] += 1 })
  return `重定位 ${counts.重定位} · 复测重算 ${counts.复测失效重算} · 复议 ${counts.复议项}`
}

function journalOf(batchId: string) {
  return segmentJournals.value.find((item) => item.batchId === batchId)
}

const statusColor: Record<string, string> = { 生效: 'success', 待复核: 'warning', 复核驳回: 'default', 写入中断: 'error' }
</script>

<template>
  <section class="page">
    <div class="split">
      <div class="segment-list">
        <button v-for="segment in store.segments" :key="segment.id" :class="{ active: segment.id === store.selectedSegmentId }" @click="store.selectedSegmentId = segment.id">
          <span>{{ segment.id }} · 限速V{{ segment.version }} · 检测V{{ segment.inspectionVersions.filter((item) => item.status !== '回填待核').length }}</span>
          <strong>{{ segment.line }}</strong>
          <small>{{ formatKm(segment.startMileage) }} - {{ formatKm(segment.endMileage) }}</small>
          <small v-if="segment.activeBatchId" class="batch-tag">纠偏 {{ segment.activeBatchId }}</small>
        </button>
      </div>
      <div v-if="store.selectedSegment" class="track-main">
        <div class="section-head">
          <div>
            <span>{{ store.selectedSegment.id }}</span>
            <h2>{{ store.selectedSegment.line }}</h2>
            <p>正式限速 {{ store.selectedSegment.speedLimit }} km/h<template v-if="store.selectedSegment.temporarySpeedLimit"> · 临时限速 {{ store.selectedSegment.temporarySpeedLimit }} km/h</template></p>
          </div>
          <div class="head-chips">
            <v-chip color="warning">限速版本 V{{ store.selectedSegment.version }}</v-chip>
            <v-chip :color="activeInspection?.status === '回填待核' ? 'error' : 'primary'">检测版本 {{ activeInspection?.id ?? '待核' }}</v-chip>
            <v-chip v-if="store.selectedSegment.activeBatchId" color="secondary">{{ store.selectedSegment.activeBatchId }}</v-chip>
          </div>
        </div>
        <MileageCanvas :segment="store.selectedSegment" :defects="segmentDefects" />

        <div v-for="journal in segmentJournals.filter((item) => item.status === '写入中断')" :key="journal.id" class="recovery-band">
          <div>
            <strong>检测批次 {{ journal.batchId }} 写入中断</strong>
            <span>{{ journal.lastError }}；已落地 {{ journal.landedKeys.length }}/{{ journal.writeKeys.length }}：{{ journal.landedKeys.join('、') || '无' }}</span>
          </div>
          <v-btn size="small" color="error" variant="flat" @click="recover(journal.id)">从完整检测批次恢复</v-btn>
        </div>

        <div class="import-panel">
          <div class="panel-title"><strong>补测纠偏导入（检测版本 / 缺陷 / 限速版本同一批次）</strong><p>轮次 {{ roundKey }} · 同区段双窗口同时导入时先到版本生效，后到内容保留待复核</p></div>
          <div class="import-grid">
            <v-select v-model="form.windowName" :items="['导入窗口甲', '导入窗口乙', '移动采集端']" label="导入窗口" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="form.operator" label="操作人" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="form.fileTag" label="补测文件标识" density="compact" variant="outlined" hide-details @change="regenerateDigest" />
            <v-text-field v-model="form.fileDigest" label="文件摘要" density="compact" variant="outlined" hide-details>
              <template #append-inner><v-btn variant="text" size="x-small" @click="regenerateDigest">重算</v-btn></template>
            </v-text-field>
            <v-text-field v-model.number="form.anchorStartDelta" type="number" label="起点锚点修正(m)" density="compact" variant="outlined" hide-details />
            <v-text-field v-model.number="form.anchorEndDelta" type="number" label="终点锚点修正(m)" density="compact" variant="outlined" hide-details />
            <v-text-field v-model.number="form.speedLimit" type="number" label="纠偏后正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
            <v-text-field v-model.number="form.temporarySpeedLimit" type="number" label="纠偏后临时限速" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
            <v-select v-model="form.failure" :items="['无', '检测写入后', '缺陷写入中', '限速写入后']" label="写入故障模拟" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="form.note" label="批次说明" density="compact" variant="outlined" hide-details />
          </div>
          <div class="import-actions">
            <v-btn color="primary" @click="importSingle">单窗口导入并生效</v-btn>
            <v-btn color="secondary" variant="tonal" @click="importPair">双窗口同时导入（仲裁演示）</v-btn>
          </div>
        </div>

        <div v-if="message" class="validation-message">{{ message }}</div>
        <div v-if="pairMessage" class="pair-message">
          <span>第一窗口：{{ pairMessage.first }}</span>
          <span>第二窗口：{{ pairMessage.second }}</span>
        </div>

        <div v-for="batch in store.pendingBatches.filter((item) => item.segmentId === store.selectedSegmentId)" :key="batch.id" class="review-band">
          <div>
            <strong>后到批次 {{ batch.id }} 待复核</strong>
            <span>{{ batch.windowName }} · 摘要 {{ batch.fileDigest }} · 同轮次 {{ batch.roundKey }} · 锚点 {{ batch.anchorStartDelta }}/{{ batch.anchorEndDelta }}m · {{ outcomeSummary(batch.id) || '内容完整保留，批准后按当前区段状态重算' }}</span>
          </div>
          <div class="review-controls">
            <v-text-field v-model="reviewState(batch.id).reviewer" label="复核人" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="reviewState(batch.id).note" label="复核意见" density="compact" variant="outlined" hide-details />
            <v-btn size="small" color="success" @click="approve(batch.id)">批准生效（新批次）</v-btn>
            <v-btn size="small" variant="outlined" @click="reject(batch.id)">驳回</v-btn>
          </div>
        </div>

        <div class="speed-panel">
          <div><strong>速度与限速联查（人工调整，独立限速版本）</strong><p>一级缺陷未关闭时，临时限速必须低于正式限速；保存后限速版本递增。</p></div>
          <v-text-field v-model.number="speed" label="正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="temporary" label="临时限速" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
          <v-btn color="primary" @click="saveSpeed">保存速度版本</v-btn>
        </div>

        <v-table density="compact" class="data-block">
          <thead><tr><th>检测/限速版本</th><th>版本号</th><th>测量/生效时间</th><th>摘要 / 限速</th><th>来源批次</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="version in [...store.selectedSegment.inspectionVersions].reverse()" :key="version.id">
              <td>检测 {{ version.id }}</td><td>V{{ version.version }}</td><td>{{ version.measuredAt.replace('T', ' ').slice(0, 16) }}</td>
              <td>{{ version.fileDigest ?? '—' }} · {{ version.sampleCount }}点</td><td>{{ version.batchId ?? '历史回填' }}</td>
              <td><v-chip size="x-small" :color="version.status === '生效' ? 'success' : version.status === '回填待核' ? 'error' : 'default'">{{ version.status }}</v-chip></td>
            </tr>
            <tr v-for="version in [...store.selectedSegment.speedLimitVersions].reverse()" :key="version.id">
              <td>限速 {{ version.id }}</td><td>V{{ version.version }}</td><td>{{ version.effectiveAt.replace('T', ' ').slice(0, 16) }}</td>
              <td>{{ version.speedLimit }} / {{ version.temporarySpeedLimit ?? '无' }} km/h</td><td>{{ version.batchId ?? '历史回填/人工' }}</td>
              <td>{{ segmentBatches.some((b) => b.id === version.batchId && b.status !== '生效') ? '随批次待生效' : '生效历史链' }}</td>
            </tr>
          </tbody>
        </v-table>

        <v-table density="compact" class="data-block">
          <thead><tr><th>纠偏批次</th><th>窗口/轮次</th><th>状态</th><th>锚点修正</th><th>缺陷处置</th><th>写入进度</th></tr></thead>
          <tbody>
            <tr v-for="batch in segmentBatches" :key="batch.id">
              <td>{{ batch.id }}</td><td>{{ batch.windowName }} · {{ batch.roundKey }}</td>
              <td><v-chip size="x-small" :color="statusColor[batch.status]">{{ batch.status }}</v-chip></td>
              <td>{{ batch.anchorStartDelta }} / {{ batch.anchorEndDelta }} m</td>
              <td>{{ outcomeSummary(batch.id) }}</td>
              <td>
                <template v-if="journalOf(batch.id)">{{ journalOf(batch.id)!.landedKeys.length }}/{{ journalOf(batch.id)!.writeKeys.length }} 键落地</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </v-table>

        <v-table density="compact" class="data-block">
          <thead><tr><th>关联缺陷</th><th>里程</th><th>类型</th><th>严重度</th><th>状态</th><th>检测版本</th><th>纠偏标记</th></tr></thead>
          <tbody>
            <tr v-for="item in segmentDefects" :key="item.id">
              <td>{{ item.id }}</td><td>{{ formatKm(item.mileage) }}</td><td>{{ item.type }}</td><td>{{ item.severity }}</td><td>{{ item.status }}</td>
              <td><v-chip size="x-small" :color="item.inspectionVersionUnverified ? 'error' : 'default'">{{ item.inspectionVersionUnverified ? '待核' : item.inspectionVersionId }}</v-chip></td>
              <td>
                <v-chip v-if="item.closedBasis?.reviewBatchIds.length" size="x-small" color="secondary">复议项 {{ item.closedBasis.reviewBatchIds.length }}</v-chip>
                <v-chip v-else-if="item.lastBatchId" size="x-small" color="warning">已重定位 {{ item.lastBatchId }}</v-chip>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
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
.segment-list .batch-tag { color: #8c6a2f; }
.track-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.head-chips { display: flex; gap: 6px; align-items: flex-start; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }
.section-head span { color: #738180; font-size: 11px; }.section-head h2 { margin: 4px 0; font-size: 20px; }.section-head p { margin: 0; color: #60706f; }
.import-panel { border: 1px solid #d4c59a; background: #fdfaf1; padding: 14px; margin-top: 14px; }
.panel-title p { margin: 3px 0 10px; color: #8a7c55; font-size: 11px; }
.import-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.import-actions { display: flex; gap: 10px; margin-top: 12px; }
.recovery-band { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 14px; margin-top: 12px; border-left: 3px solid #b84239; background: #fbecea; }
.recovery-band span { display: block; color: #8a4a44; font-size: 11px; margin-top: 3px; }
.review-band { border-left: 3px solid #b18b38; background: #fbf6e9; padding: 11px 14px; margin-top: 12px; }
.review-band > div:first-child span { display: block; color: #7b6f4e; font-size: 11px; margin-top: 3px; }
.review-controls { display: grid; grid-template-columns: 150px 1fr auto auto; gap: 10px; margin-top: 10px; align-items: center; }
.speed-panel { display: grid; grid-template-columns: 1fr 130px 130px auto; gap: 10px; align-items: center; margin: 14px 0; padding: 12px; background: #f4f7f7; }
.speed-panel p { margin: 4px 0 0; color: #71807f; font-size: 11px; }
.validation-message { color: #a33a35; font-size: 12px; margin: 10px 0; }
.pair-message { display: grid; gap: 4px; font-size: 12px; color: #6d5d36; background: #f7f2e3; padding: 9px 12px; margin: 8px 0; }
.data-block { margin-top: 14px; }
</style>
