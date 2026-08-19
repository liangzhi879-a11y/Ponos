const exe = process.argv[2]
const ico = process.argv[3]

if (!exe || !ico) {
  console.error('Usage: node scripts/patch-icon.mjs <exe> <ico>')
  process.exit(1)
}

try {
  const { rcedit } = await import('rcedit')
  await rcedit(exe, { icon: ico })
  console.log('Icon patched successfully')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exit(1)
}
