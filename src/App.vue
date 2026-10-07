<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useTrackStore } from './stores/track'

const route = useRoute()
const store = useTrackStore()
const title = computed(() => route.name === 'track' ? '区段里程与缺陷分布' : route.name === 'workOrders' ? '整治任务与复测' : route.name === 'audit' ? '整治审计' : '轨道缺陷总览')
const dataState = computed(() => {
  if (store.interruptedJournals.length) return { tone: 'error', title: `${store.interruptedJournals.length}个纠偏批次写入中断`, sub: '从完整检测批次恢复后继续' }
  if (store.pendingBatches.length) return { tone: 'warn', title: `${store.pendingBatches.length}个后到版本待复核`, sub: '先到版本已生效' }
  if (store.segments.some((item) => item.activeBatchId)) return { tone: 'ok', title: '纠偏批次已生效', sub: '检测/缺陷/限速同批对齐' }
  return { tone: 'idle', title: '轨检车数据已导入', sub: '旧检测版本已按时间回填' }
})
</script>

<template>
  <v-app>
    <aside class="shell-nav">
      <div class="brand"><div class="brand-mark"><strong>轨</strong></div><div><b>轨道几何整治台</b><span>缺陷派工、复测与限速联查</span></div></div>
      <nav>
        <RouterLink to="/"><span>缺陷总览</span><small>{{ store.filtered.length }} 项</small></RouterLink>
        <RouterLink to="/track"><span>里程与纠偏批次</span><small>{{ store.batches.length }} 批</small></RouterLink>
        <RouterLink to="/work-orders"><span>整治复测</span><small>{{ store.defects.filter((item) => item.status !== '已关闭').length }} 项</small></RouterLink>
        <RouterLink to="/audit"><span>审计追溯</span><small>{{ store.audit.length }} 条</small></RouterLink>
      </nav>
      <div class="aside-data" :class="dataState.tone"><span>数据接入</span><strong>{{ dataState.title }}</strong><small>{{ dataState.sub }} · 本地持久化 / 可离线补录</small></div>
    </aside>
    <v-main class="shell-main">
      <header class="top"><div><span>工务调度中心 / 轨道几何</span><h1>{{ title }}</h1></div><div><small>线别</small><strong>京广上行 / 沪昆下行</strong></div></header>
      <RouterView />
    </v-main>
  </v-app>
</template>

<style scoped>
.brand-mark { width: 40px; height: 40px; display: grid; place-items: center; background: #c69c3f; color: #25394a; border-radius: 4px; font-size: 19px; }
.aside-data.error { background: #4a2220; }.aside-data.warn { background: #3d3420; }.aside-data.ok { background: #1f3d2c; }
</style>
