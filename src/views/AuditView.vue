<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const keyword = ref('')
const batchOnly = ref(false)
const rows = computed(() => store.audit
  .filter((item) => !batchOnly.value || item.batchId)
  .filter((item) => `${item.entityId} ${item.action} ${item.operator} ${item.detail} ${item.batchId ?? ''}`.includes(keyword.value)))
function exportReport() {
  const payload = {
    generatedAt: new Date().toISOString(),
    schema: store.schema,
    segments: store.segments,
    defects: store.defects,
    correctionBatches: store.batches,
    recoveryJournals: store.journals,
    audit: store.audit,
    consistency: {
      activeBatches: store.segments.map((segment) => ({ segmentId: segment.id, activeBatchId: segment.activeBatchId ?? null })),
      pendingReview: store.pendingBatches.map((item) => item.id),
      interrupted: store.interruptedJournals.map((item) => item.batchId),
      unverifiedDefects: store.defects.filter((item) => item.inspectionVersionUnverified).map((item) => item.id),
      closedReviewItems: store.reviewItems.map((item) => ({ defectId: item.id, reviewBatchIds: item.closedBasis?.reviewBatchIds ?? [] }))
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '轨道几何整治报告.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page audit-page">
    <div class="section-head">
      <div><h2>整治审计与版本追溯</h2><p>检测数据版本、缺陷重定位、复测失效重算、限速版本与恢复动作全部挂同一纠偏批次；页面、里程图与导出口径一致。</p></div>
      <v-btn color="primary" @click="exportReport">导出整治报告</v-btn>
    </div>
    <div class="toolbar single">
      <v-text-field v-model="keyword" density="compact" variant="outlined" hide-details prepend-inner-icon="mdi-magnify" placeholder="搜索实体、动作、操作人、批次或说明" />
      <v-checkbox v-model="batchOnly" label="仅看纠偏批次" density="compact" hide-details color="primary" />
      <span>共{{ rows.length }}条 · 批次{{ store.batches.length }} · 中断{{ store.interruptedJournals.length }} · 待核{{ store.defects.filter((item) => item.inspectionVersionUnverified).length }}</span>
    </div>
    <v-table density="compact">
      <thead><tr><th>时间</th><th>实体</th><th>动作</th><th>纠偏批次</th><th>操作人</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="item in rows" :key="item.id" :class="{ batchRow: item.batchId }">
          <td>{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</td>
          <td>{{ item.entityId }}</td>
          <td>{{ item.action }}</td>
          <td><v-chip v-if="item.batchId" size="x-small" color="secondary">{{ item.batchId }}</v-chip><span v-else>—</span></td>
          <td>{{ item.operator }}</td>
          <td>{{ item.detail }}</td>
        </tr>
      </tbody>
    </v-table>
  </section>
</template>

<style scoped>
.audit-page :deep(.v-table) { background: white; border: 1px solid #dae1e2; }
.audit-page tr.batchRow { background: #fbf7ec; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head h2 { margin: 0 0 5px; font-size: 19px; }.section-head p { margin: 0; color: #71807e; font-size: 12px; }
.toolbar.single { display: grid; grid-template-columns: 420px 180px auto; gap: 12px; margin-bottom: 10px; align-items: center; }.toolbar.single span { color: #71807e; font-size: 11px; }
</style>
