<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CorrectionBatch, Defect, ReconsiderationItem, TrackSegment } from '../types'

const props = defineProps<{ segment?: TrackSegment; defects: Defect[]; reconsiderations?: ReconsiderationItem[]; activeBatch?: CorrectionBatch | null }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const zoom = ref(1)
const selectedMileage = ref<number | null>(null)

function draw() {
  const element = canvas.value
  if (!element || !props.segment) return
  const ctx = element.getContext('2d')
  if (!ctx) return
  const ratio = window.devicePixelRatio || 1
  const width = element.clientWidth
  const height = 250
  element.width = width * ratio
  element.height = height * ratio
  ctx.scale(ratio, ratio)
  ctx.clearRect(0, 0, width, height)
  const padding = 38
  const trackY = 148
  ctx.fillStyle = '#f8faf9'
  ctx.fillRect(0, 0, width, height)

  // 批次色带：页面与里程图显示同一纠偏批次
  if (props.activeBatch) {
    ctx.fillStyle = 'rgba(198,156,63,0.16)'
    ctx.fillRect(padding, 6, width - padding * 2, 22)
    ctx.fillStyle = '#8c6a2f'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText(`纠偏批次 ${props.activeBatch.id} · 检测版本 ${props.activeBatch.plan.inspectionVersion?.id ?? ''} · 限速 V${props.activeBatch.plan.speedVersion.version}`, width / 2, 21)
  }

  ctx.strokeStyle = '#9aa8a7'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(padding, trackY)
  ctx.lineTo(width - padding, trackY)
  ctx.stroke()
  for (let index = 0; index <= 10; index += 1) {
    const x = padding + (index / 10) * (width - padding * 2)
    ctx.beginPath(); ctx.moveTo(x, trackY - 8); ctx.lineTo(x, trackY + 8); ctx.stroke()
    ctx.fillStyle = '#657473'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
    const mileage = props.segment.startMileage + index * (props.segment.endMileage - props.segment.startMileage) / 10
    ctx.fillText(`K${Math.floor(mileage / 1000)}+${String(Math.round(mileage % 1000)).padStart(3, '0')}`, x, trackY + 28)
  }
  const maxGauge = Math.max(...props.segment.measurements.map((item) => item.gauge))
  const span = Math.max(1, props.segment.endMileage - props.segment.startMileage)
  const xOf = (mileage: number) => padding + ((mileage - props.segment!.startMileage) / span) * (width - padding * 2)
  props.segment.measurements.forEach((point, index) => {
    const x = xOf(point.mileage)
    const y = 74 + (maxGauge - point.gauge) * 18
    ctx.strokeStyle = '#2e6678'; ctx.lineWidth = 2
    if (index) {
      const previous = props.segment!.measurements[index - 1]
      const px = xOf(previous.mileage)
      const py = 74 + (maxGauge - previous.gauge) * 18
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke()
    }
    // 绑定到当前生效批次检测版本的采样点用金色描边
    const inBatch = props.activeBatch && point.inspectionVersionId === props.activeBatch.plan.inspectionVersion?.id
    ctx.fillStyle = point.gauge > 1446 ? '#b84239' : '#2e6678'
    ctx.beginPath(); ctx.arc(x, y, point.gauge > 1446 ? 4.5 : 3, 0, Math.PI * 2); ctx.fill()
    if (inBatch) { ctx.strokeStyle = '#c69c3f'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke() }
  })
  props.defects.filter((item) => item.segmentId === props.segment!.id).forEach((defect) => {
    const x = xOf(defect.mileage)
    const stale = defect.status !== '已关闭' && defect.retests.some((retest) => retest.invalidatedAt)
    ctx.fillStyle = defect.status === '已关闭' ? '#43876b' : stale ? '#b18b38' : '#b84239'
    ctx.beginPath(); ctx.moveTo(x, trackY - 18); ctx.lineTo(x - 7, trackY - 31); ctx.lineTo(x + 7, trackY - 31); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#334241'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(defect.type, x, trackY - 36)
    // 复测结论失效标记
    if (stale) { ctx.strokeStyle = '#b18b38'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, trackY - 25, 10, 0, Math.PI * 2); ctx.stroke() }
  })
  // 复议项：已关闭缺陷纠偏后的新里程（空心三角 + 虚线偏移）；随批次作废的不显示
  for (const item of props.reconsiderations ?? []) {
    if (item.segmentId !== props.segment!.id || item.status === '随批次作废') continue
    const x1 = xOf(item.closedMileage), x2 = xOf(item.newMileage)
    ctx.strokeStyle = '#b18b38'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x1, trackY + 10); ctx.lineTo(x2, trackY + 10); ctx.stroke(); ctx.setLineDash([])
    ctx.strokeStyle = item.status === '待复议' ? '#b18b38' : '#7a8a88'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(x2, trackY + 12); ctx.lineTo(x2 - 6, trackY + 23); ctx.lineTo(x2 + 6, trackY + 23); ctx.closePath(); ctx.stroke()
    ctx.fillStyle = '#8c6a2f'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'
    if (item.status === '待复议') ctx.fillText('复议', x2, trackY + 34)
  }
  if (selectedMileage.value !== null) {
    const x = xOf(selectedMileage.value)
    ctx.strokeStyle = '#b18b38'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, trackY + 8); ctx.stroke(); ctx.setLineDash([])
  }
}

function locate(event: MouseEvent) {
  if (!props.segment || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const ratio = Math.min(1, Math.max(0, (x - 38) / (rect.width - 76)))
  const span = Math.max(1, props.segment.endMileage - props.segment.startMileage)
  selectedMileage.value = Math.round(props.segment.startMileage + ratio * span)
}

onMounted(() => { draw(); window.addEventListener('resize', draw) })
watch([() => props.segment, () => props.defects, () => props.reconsiderations, () => props.activeBatch, zoom, selectedMileage], draw, { deep: true })
</script>

<template>
  <div class="canvas-panel">
    <div class="canvas-head">
      <div><strong>里程—轨距分布</strong><span v-if="selectedMileage">定位 K{{ Math.floor(selectedMileage / 1000) }}+{{ String(selectedMileage % 1000).padStart(3, '0') }}</span><span v-else-if="activeBatch">当前显示批次 {{ activeBatch.id }}</span></div>
      <div><v-btn size="x-small" variant="outlined" @click="zoom = Math.max(.7, zoom - .1)">缩小</v-btn><v-btn size="x-small" variant="outlined" @click="zoom = Math.min(1.3, zoom + .1)">放大</v-btn></div>
    </div>
    <canvas ref="canvas" :style="{ transform: `scale(${zoom})`, transformOrigin: 'left center' }" @click="locate" />
    <div class="canvas-note">
      红点超限、三角为缺陷；<b style="color:#b18b38">琥珀色</b>表示复测结论已随里程纠偏失效待重算；
      空心三角为已关闭缺陷的复议新里程；金圈为当前批次采样点。点击里程可定位。
    </div>
  </div>
</template>
