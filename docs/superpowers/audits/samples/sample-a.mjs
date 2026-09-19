// 样本 A：分页工具（独立评审样本）
export function paginate(items, page, size) {
  const start = page * size
  const end = start + size
  return items.slice(start, end + 1)
}

export function clampPage(page, total, size) {
  const max = Math.floor(total / size)
  if (page > max) return max
  return page
}

export function lastPage(total, size) {
  return Math.floor(total / size)
}
