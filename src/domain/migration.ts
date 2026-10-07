import type { AuditEntry, Defect, SpeedLimitVersion, TrackSegment } from '../types'
import { formatKm, sampleDigest } from './correction'

interface PersistedShape {
  schema?: number
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
}

export interface MigrationResult {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
  backfilled: { segmentId: string; versionId: string; version: number }[]
  unverified: number
}

/**
 * 旧数据回填：检测点按测量时间（同日）分组生成检测版本，文件摘要由采样点推导；
 * 缺陷按区段+发现时间挂到不晚于该时间的最近版本；无法确认的先待核。
 */
export function migrateLegacy(raw: PersistedShape): MigrationResult {
  const segments = raw.segments.map((segment) => withBackfilledVersions(segment))
  const defects = raw.defects.map((defect) => attachDefectVersion(defect, segments))
  const audit = raw.audit.some((item) => item.action === '旧数据回填检测版本') ? raw.audit : [...raw.audit, ...backfillAudit(segments, defects)]
  const backfilled = segments.flatMap((segment) => segment.inspectionVersions
    .filter((item) => item.source === '历史回填' && item.status === '生效')
    .map((item) => ({ segmentId: segment.id, versionId: item.id, version: item.version })))
  const unverified = defects.filter((item) => item.inspectionVersionUnverified).length
  return { segments, defects, audit, backfilled, unverified }
}

function withBackfilledVersions(segment: TrackSegment): TrackSegment {
  if (segment.inspectionVersions?.length) return segment
  const groups = new Map<string, typeof segment.measurements>()
  for (const point of segment.measurements) {
    const dateKey = point.measuredAt.slice(0, 10)
    const group = groups.get(dateKey) ?? []
    group.push(point)
    groups.set(dateKey, group)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  const inspectionVersions = ordered.map(([dateKey, points], index) => {
    const digest = sampleDigest(segment.id, dateKey, points)
    return {
      id: `IV-LEGACY-${segment.id}-${dateKey}`,
      segmentId: segment.id,
      version: index + 1,
      measuredAt: points.map((point) => point.measuredAt).sort()[0],
      detector: detectorLabel(points),
      fileDigest: digest,
      status: index === ordered.length - 1 ? ('生效' as const) : ('历史' as const),
      source: '历史回填' as const,
      sampleCount: points.length,
      note: `旧数据按测量时间 ${dateKey} 回填`
    }
  })
  for (const point of segment.measurements) {
    const dateKey = point.measuredAt.slice(0, 10)
    point.inspectionVersionId = `IV-LEGACY-${segment.id}-${dateKey}`
  }
  const speedLimitVersions: SpeedLimitVersion[] = [{
    id: `SV-LEGACY-${segment.id}`,
    segmentId: segment.id,
    version: segment.version,
    speedLimit: segment.speedLimit,
    temporarySpeedLimit: segment.temporarySpeedLimit,
    effectiveAt: inspectionVersions[0]?.measuredAt ?? '2026-09-28T00:00:00',
    source: '历史回填',
    note: '旧数据回填限速版本，纠偏批次生效后由新版本取代'
  }]
  return { ...segment, inspectionVersions, speedLimitVersions }
}

function detectorLabel(points: TrackSegment['measurements']): string {
  const detectors = new Set(points.map((point) => point.detector))
  return detectors.size === 1 ? [...detectors][0] : [...detectors].join('/')
}

function attachDefectVersion(defect: Defect, segments: TrackSegment[]): Defect {
  // 已挂过检测版本的数据不重复回填；旧数据无 inspectionVersionId
  if (defect.mileageHistory && defect.inspectionVersionId !== undefined) return defect
  const segment = segments.find((item) => item.id === defect.segmentId)
  const enriched: Defect = { ...defect, mileageHistory: [], retests: defect.retests.map((item) => ({ ...item, valid: true })) }
  const candidates = (segment?.inspectionVersions ?? [])
    .filter((item) => item.measuredAt.slice(0, 10) <= defect.discoveredAt.slice(0, 10))
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))
  const match = candidates[0]
  if (!match) {
    enriched.inspectionVersionId = `IV-PENDING-${defect.segmentId}`
    enriched.inspectionVersionUnverified = true
    return enriched
  }
  enriched.inspectionVersionId = match.id
  if (enriched.status === '已关闭') {
    const passed = enriched.retests.filter((item) => item.passed)
    enriched.closedBasis = {
      mileage: enriched.mileage,
      inspectionVersionId: match.id,
      speedLimitVersionId: `SV-LEGACY-${enriched.segmentId}`,
      closedAt: passed[0]?.testedAt ?? enriched.discoveredAt,
      retestSnapshot: structuredClone(enriched.retests),
      reviewBatchIds: [],
      note: '旧数据回填关闭依据：关闭里程、复测结论与当时限速版本快照'
    }
  }
  return enriched
}

function backfillAudit(segments: TrackSegment[], defects: Defect[]): AuditEntry[] {
  const entries: AuditEntry[] = segments.flatMap((segment) => segment.inspectionVersions.map((version) => ({
    id: `A-LEGACY-IV-${version.id}`,
    entityId: segment.id,
    action: '旧数据回填检测版本',
    operator: '迁移任务',
    detail: `按测量时间 ${version.measuredAt.slice(0, 10)} 回填检测版本 V${version.version}，文件摘要 ${version.fileDigest ?? '无'}，采样 ${version.sampleCount} 点`,
    createdAt: version.measuredAt
  })))
  for (const defect of defects) {
    if (defect.inspectionVersionUnverified) {
      entries.push({
        id: `A-LEGACY-UNV-${defect.id}`,
        entityId: defect.id,
        action: '检测版本待核',
        operator: '迁移任务',
        detail: `发现于 ${formatKm(defect.mileage)}（${defect.discoveredAt.slice(0, 10)}），测量时间与文件摘要均无法对应检测批次，先待核`,
        createdAt: defect.discoveredAt
      })
    }
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function addPendingPlaceholders(segments: TrackSegment[], defects: Defect[]): TrackSegment[] {
  const pending = new Set(defects.filter((item) => item.inspectionVersionUnverified).map((item) => item.segmentId))
  return segments.map((segment) => pending.has(segment.id) && !segment.inspectionVersions.some((item) => item.id === `IV-PENDING-${segment.id}`)
    ? {
        ...segment,
        inspectionVersions: [{
          id: `IV-PENDING-${segment.id}`,
          segmentId: segment.id,
          version: 0,
          measuredAt: '1970-01-01T00:00:00',
          detector: '未知',
          fileDigest: null,
          status: '回填待核',
          source: '历史回填',
          sampleCount: 0,
          note: '旧缺陷无法确认检测批次，先待核'
        }, ...segment.inspectionVersions]
      }
    : segment)
}
