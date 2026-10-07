<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMutation, useQuery } from '@vue/apollo-composable'
import { gql } from '@apollo/client/core'
import { useTrackStore } from '../stores/track'
import { formatKm } from '../domain/correction'
import type { DefectStatus } from '../types'

const store = useTrackStore()
const router = useRouter()
const TrackSegments = gql`query TrackSegments { segments { id line startMileage endMileage speedLimit version } }`
const { result: segmentResult, loading } = useQuery(TrackSegments)
void useMutation(gql`mutation AssignDefects($ids: [ID!]!, $owner: String!) { assignDefects(ids: [ID!], owner: String!) { ok } }`)
const selected = ref<string[]>([])
const owner = ref('工务一工区')
const headers = [
  { title: '缺陷编号', key: 'id' },
  { title: '区段', key: 'segmentId' },
  { title: '里程', key: 'mileage' },
  { title: '类型', key: 'type' },
  { title: '严重度', key: 'severity' },
  { title: '实测/限值', key: 'value' },
  { title: '状态', key: 'status' },
  { title: '责任工区', key: 'owner' },
  { title: '检测版本 / 批次', key: 'batch' },
  { title: '', key: 'actions' }
]
const statuses: Array<DefectStatus | '全部'> = ['全部', '待派工', '整治中', '待复测', '复测不合格', '已关闭']
function assign() {
  store.assign(selected.value, owner.value)
  selected.value = []
}
function invalidRetests(item: { retests: Array<{ valid: boolean }> }) {
  return item.retests.filter((retest) => !retest.valid).length
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article><span>超限缺陷</span><strong>{{ store.defects.length }}</strong><small>含已关闭项</small></article>
      <article><span>一级缺陷</span><strong>{{ store.defects.filter((item) => item.severity === '一级' && item.status !== '已关闭').length }}</strong><small>需限速联查</small></article>
      <article><span>复测失效待重算</span><strong>{{ store.defects.filter((item) => item.retests.some((retest) => !retest.valid) && item.status !== '已关闭').length }}</strong><small>纠偏后旧结论失效</small></article>
      <article><span>纠偏批次 / 待复核</span><strong>{{ store.pendingBatches.length }}</strong><small>共{{ store.batches.length }}个批次，后到{{ store.pendingBatches.length }}个待复核</small></article>
    </div>
    <div class="toolbar">
      <v-text-field v-model="store.keyword" density="compact" variant="outlined" hide-details prepend-inner-icon="mdi-magnify" placeholder="搜索缺陷、区段、类型或工区" />
      <v-select v-model="store.status" :items="statuses" density="compact" variant="outlined" hide-details />
      <v-select v-model="owner" :items="['工务一工区', '工务二工区', '桥隧工区']" density="compact" variant="outlined" hide-details />
      <v-btn color="primary" :disabled="!selected.length" @click="assign">批量派工 {{ selected.length ? `(${selected.length})` : '' }}</v-btn>
    </div>
    <div class="query-band">
      <span>{{ loading ? 'GraphQL数据读取中' : `GraphQL已返回${segmentResult?.segments?.length ?? 0}个区段` }}</span>
      <span>检测版本待核 {{ store.defects.filter((item) => item.inspectionVersionUnverified).length }} 项 · 已关闭复议 {{ store.reviewItems.length }} 项 · 写入中断 {{ store.interruptedJournals.length }} 批</span>
    </div>
    <v-data-table v-model="selected" :headers="headers" :items="store.filtered" item-value="id" show-select density="compact" :items-per-page="12">
      <template #item.value="{ item }">{{ item.measuredValue }} / {{ item.limit }}</template>
      <template #item.severity="{ item }"><v-chip size="small" :color="item.severity === '一级' ? 'error' : item.severity === '二级' ? 'warning' : 'default'">{{ item.severity }}</v-chip></template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="item.status === '已关闭' ? 'success' : item.status === '复测不合格' ? 'error' : 'warning'">{{ item.status }}</v-chip>
        <v-chip v-if="invalidRetests(item)" size="x-small" color="error" class="ml-1">复测失效×{{ invalidRetests(item) }}</v-chip>
      </template>
      <template #item.mileage="{ item }">{{ formatKm(item.mileage) }}</template>
      <template #item.batch="{ item }">
        <v-chip size="x-small" :color="item.inspectionVersionUnverified ? 'error' : 'default'">{{ item.inspectionVersionUnverified ? '待核' : item.inspectionVersionId }}</v-chip>
        <v-chip v-if="item.closedBasis?.reviewBatchIds.length" size="x-small" color="secondary" class="ml-1">复议项</v-chip>
        <v-chip v-else-if="item.lastBatchId" size="x-small" color="warning" class="ml-1">{{ item.lastBatchId }}</v-chip>
      </template>
      <template #item.actions="{ item }"><v-btn size="small" variant="text" @click="router.push(`/work-orders/${item.id}`)">处置</v-btn></template>
    </v-data-table>
  </section>
</template>

<style scoped>
.query-band { display: flex; justify-content: space-between; font-size: 11px; color: #718080; margin: 0 0 10px; }
.ml-1 { margin-left: 4px; }
</style>
