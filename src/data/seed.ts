import type { AuditEntry, Defect, GeometryMeasurement, InspectionVersion, SpeedLimitVersion, TrackSegment } from '../types'

interface MeasurementSeedOptions {
  /** 2026-09-xx 的日期部分 */
  dayStart: number
  /** 每个采样点的测量时间偏移（小时） */
  startHour: number
}

const measurements = (start: number, values: number[], options: MeasurementSeedOptions): GeometryMeasurement[] => values.map((value, index) => ({
  id: `GM-${start + index * 200}`,
  mileage: start + index * 200,
  gauge: value,
  level: +(1.5 + Math.sin(index) * 1.1).toFixed(2),
  alignment: +(0.8 + Math.cos(index / 2) * .8).toFixed(2),
  twist: +(1.0 + Math.sin(index / 3) * .9).toFixed(2),
  measuredAt: `2026-09-${String(options.dayStart + Math.floor((options.startHour + index) / 12)).padStart(2, '0')}T${String((options.startHour + index) % 12 + 1).padStart(2, '0')}:00:00`,
  detector: index % 2 ? 'GJ-6型轨检车' : '便携式激光测量仪'
}))

/** 由采样点生成检测文件摘要（稳定的短哈希，模拟文件 SHA 前缀） */
export function digestOfMeasurements(points: GeometryMeasurement[]): string {
  const body = points.map((point) => `${point.mileage}:${point.gauge}:${point.level}:${point.alignment}:${point.twist}`).join('|')
  let hash = 0
  for (let i = 0; i < body.length; i += 1) hash = (hash * 31 + body.charCodeAt(i)) >>> 0
  return hash.toString(16).toUpperCase().padStart(8, '0')
}

function buildInspectionVersion(segmentId: string, index: number, points: GeometryMeasurement[], note: string): InspectionVersion {
  const measuredAt = points.map((point) => point.measuredAt).sort()[0]
  const day = measuredAt.slice(0, 10).replace(/-/g, '')
  const short = segmentId.replace('SEG-', '')
  const digest = digestOfMeasurements(points)
  return {
    id: `IV-${short}-${day}-${digest.slice(0, 4)}${index}`,
    segmentId,
    measuredAt,
    importedAt: measuredAt,
    fileDigest: digest,
    measurementIds: points.map((point) => point.id),
    confidence: '已确认',
    note
  }
}

const k102Points = measurements(102000, [1433, 1435, 1438, 1443, 1447, 1444, 1437, 1434, 1436, 1439, 1442, 1439, 1435, 1433], { dayStart: 25, startHour: 1 })
const k208Points = [
  ...measurements(208000, [1434, 1433, 1435, 1432, 1431, 1433, 1436, 1438, 1437, 1435, 1434, 1432, 1433, 1434], { dayStart: 27, startHour: 2 }),
  // 28 日补测加密采样点，与常规检测组成同一检测批次，覆盖 K209+200 已关闭缺陷的复核
  { id: 'GM-208100', mileage: 208100, gauge: 1434, level: 1.2, alignment: 0.7, twist: 3.1, measuredAt: '2026-09-28T02:30:00', detector: 'GJ-6型轨检车' },
  { id: 'GM-208300', mileage: 208300, gauge: 1435, level: 1.5, alignment: 0.8, twist: 3.4, measuredAt: '2026-09-28T02:40:00', detector: '便携式激光测量仪' }
]

const k102Version = buildInspectionVersion('SEG-K102', 1, k102Points, '25-26 日轨检车常规检测批次')
const k208Version = buildInspectionVersion('SEG-K208', 2, k208Points, '27 日常规检测 + 28 日补测复核批次')

for (const point of k102Points) point.inspectionVersionId = k102Version.id
for (const point of k208Points) point.inspectionVersionId = k208Version.id

const k102SpeedHistory: SpeedLimitVersion[] = [
  { version: 3, speedLimit: 160, temporarySpeedLimit: 120, changedAt: '2026-09-28T09:00:00', note: '一级缺陷整治期间临时限速' },
  { version: 4, speedLimit: 160, temporarySpeedLimit: 120, changedAt: '2026-09-29T05:30:00', note: '常规限速复核（手工调整）' }
]
const k208SpeedHistory: SpeedLimitVersion[] = [
  { version: 2, speedLimit: 200, changedAt: '2026-09-26T10:00:00', note: '区段开通限速' },
  { version: 3, speedLimit: 200, changedAt: '2026-09-28T06:00:00', note: '补测后限速复核（手工调整）' }
]

export const seedSegments: TrackSegment[] = [
  { id: 'SEG-K102', line: '京广上行 K102', startMileage: 102000, endMileage: 104800, speedLimit: 160, temporarySpeedLimit: 120, version: 4, measurements: k102Points, speedLimitHistory: k102SpeedHistory },
  { id: 'SEG-K208', line: '沪昆下行 K208', startMileage: 208000, endMileage: 209400, speedLimit: 200, version: 3, measurements: k208Points, speedLimitHistory: k208SpeedHistory }
]

export const seedInspectionVersions: InspectionVersion[] = [k102Version, k208Version]

export const seedDefects: Defect[] = [
  {
    id: 'GD-260929-01', segmentId: 'SEG-K102', mileage: 102800, type: '轨距', severity: '一级', measuredValue: 1447, limit: 1446, status: '整治中', owner: '工务一工区', discoveredAt: '2026-09-29T02:10:00', dueDate: '2026-09-29', version: 3,
    // 9-29 才发现，晚于 25-26 日检测批次，按测量时间无法确认，先待核，待补测批次确认
    inspectionVersionId: undefined, versionConfidence: '待核', mileageHistory: [],
    actions: [{ method: '捣固', note: '完成轨向调整，待复测轨距', operator: '李海', recordedAt: '2026-09-29T07:20:00' }], retests: []
  },
  {
    id: 'GD-260929-02', segmentId: 'SEG-K102', mileage: 103400, type: '高低', severity: '二级', measuredValue: 8.6, limit: 8.0, status: '待复测', owner: '工务一工区', discoveredAt: '2026-09-29T02:20:00', dueDate: '2026-09-30', version: 4,
    inspectionVersionId: undefined, versionConfidence: '待核', mileageHistory: [],
    actions: [{ method: '打磨', note: '波磨处理完成', operator: '周旭', recordedAt: '2026-09-29T09:10:00' }],
    retests: [{ round: 1, passed: false, measuredValue: 8.4, limit: 8.0, note: '仍高于限值', tester: '王磊', testedAt: '2026-09-29T11:30:00' }]
  },
  {
    id: 'GD-260928-07', segmentId: 'SEG-K208', mileage: 209200, type: '三角坑', severity: '三级', measuredValue: 7.5, limit: 8.0, status: '已关闭', owner: '工务二工区', discoveredAt: '2026-09-28T03:00:00', dueDate: '2026-09-29', version: 5,
    inspectionVersionId: k208Version.id, versionConfidence: '已确认', mileageHistory: [],
    actions: [{ method: '垫板调整', note: '调整连续三块垫板', operator: '陈伟', recordedAt: '2026-09-28T08:40:00' }],
    retests: [{ round: 1, passed: true, measuredValue: 6.8, limit: 8.0, note: '满足验收标准', tester: '魏强', testedAt: '2026-09-28T15:20:00' }],
    closedBasis: {
      mileage: 209200, retestRound: 1, measuredValue: 6.8, limit: 8.0, tester: '魏强', testedAt: '2026-09-28T15:20:00', closedAt: '2026-09-28T15:20:00', inspectionVersionId: k208Version.id, note: '第1轮复测 6.8 满足验收标准，关闭时里程 K209+200 保留为当时依据'
    }
  }
]

export const seedAudit: AuditEntry[] = [
  { id: 'A-1', entityId: 'SEG-K102', action: '导入检测数据', operator: 'GJ-6轨检车', detail: `导入K102+000至K104+800共14个采样点（检测版本 ${k102Version.id}）`, createdAt: '2026-09-29T02:00:00' },
  { id: 'A-2', entityId: 'GD-260929-01', action: '批量派工', operator: '调度员 方林', detail: '超限点分配至工务一工区，要求24小时内整治；检测版本待核', createdAt: '2026-09-29T04:15:00' },
  { id: 'A-3', entityId: 'GD-260929-02', action: '提交复测', operator: '王磊', detail: '第1轮复测未通过，重新进入整治（检测版本待核）', createdAt: '2026-09-29T11:30:00' },
  { id: 'A-4', entityId: k208Version.id, action: '旧数据回填检测版本', operator: '系统迁移', detail: `按测量时间与文件摘要 ${k208Version.fileDigest} 回填 ${k208Points.length} 个采样点，GD-260928-07 已确认`, createdAt: '2026-10-07T08:00:00' },
  { id: 'A-5', entityId: 'SEG-K102', action: '旧数据回填检测版本', operator: '系统迁移', detail: `GD-260929-01、GD-260929-02 测量时间晚于检测批次 ${k102Version.id}，无法确认，标记待核`, createdAt: '2026-10-07T08:00:00' }
]
