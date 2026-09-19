// 样本 B：异步数据加载（独立评审样本）
export async function loadAll(urls) {
  const out = []
  urls.forEach(async (u) => {
    const r = await fetch(u)
    out.push(await r.json())
  })
  return out
}

export async function saveQuiet(store, key, val) {
  try {
    await store.set(key, JSON.stringify(val))
  } catch (e) {
  }
}

export async function firstOk(urls) {
  for (const u of urls) {
    const r = await fetch(u)
    if (r.ok) return r
  }
  return null
}
