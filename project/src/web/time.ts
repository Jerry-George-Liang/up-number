export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '时间未知'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '时间未知'
  const delta = timestamp - now
  const absolute = Math.abs(delta)
  if (absolute < 60_000) return delta <= 0 ? '刚刚' : '即将'

  const units = [
    { limit: 60 * 60_000, size: 60_000, label: '分钟' },
    { limit: 24 * 60 * 60_000, size: 60 * 60_000, label: '小时' },
    { limit: 30 * 24 * 60 * 60_000, size: 24 * 60 * 60_000, label: '天' },
    { limit: 365 * 24 * 60 * 60_000, size: 30 * 24 * 60 * 60_000, label: '个月' },
    { limit: Number.POSITIVE_INFINITY, size: 365 * 24 * 60 * 60_000, label: '年' },
  ]
  const unit = units.find((candidate) => absolute < candidate.limit)!
  const amount = Math.max(1, Math.floor(absolute / unit.size))
  return delta < 0 ? `${amount}${unit.label}前` : `${amount}${unit.label}后`
}

export function formatExactTime(value: string | null | undefined): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}
