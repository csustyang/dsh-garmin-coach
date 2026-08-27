/**
 * Garmin 连接测试（新 DI OAuth2 认证）。
 * 用法：GARMIN_EMAIL=xxx GARMIN_PASSWORD=xxx npx tsx scripts/connect-test.ts
 */
import { GarminClient } from '../src/auth/client.js'
import { FileTokenStore } from '../src/auth/file-store.js'
import { makeQueries } from '../src/api/queries.js'

async function main() {
  const email = process.env.GARMIN_EMAIL
  const password = process.env.GARMIN_PASSWORD
  if (!email || !password) {
    console.error('请设置 GARMIN_EMAIL 和 GARMIN_PASSWORD')
    process.exit(1)
  }
  const store = new FileTokenStore('./.garmin-test/tokens.json', './.garmin-test/mfa-state.json')
  const client = new GarminClient({ store })

  console.log(`[1] 登录 ${email.slice(0, 3)}*** ...`)
  const result = await client.login(email, password)
  if (result.kind === 'ok') {
    console.log(`✓ 登录成功！用户: ${result.tokens.displayName}`)
    console.log('  DI token 已缓存')

    // 测试查询
    console.log('\n[2] 测试查询 daily...')
    try {
      const queries = makeQueries(client)
      const daily = await queries.daily()
      console.log('  daily 返回:', JSON.stringify(daily).slice(0, 200))
    } catch (e) {
      console.error('  daily 失败:', e instanceof Error ? e.message : String(e))
    }

    console.log('\n[3] 测试查询 activities...')
    try {
      const queries = makeQueries(client)
      const activities = await queries.activities({ limit: 3 })
      console.log('  activities 数量:', Array.isArray(activities) ? activities.length : '?')
      if (Array.isArray(activities) && activities.length > 0) {
        console.log('  第一条:', JSON.stringify(activities[0]).slice(0, 300))
      }
    } catch (e) {
      console.error('  activities 失败:', e instanceof Error ? e.message : String(e))
    }
  } else if (result.kind === 'mfa_required') {
    console.log(`需要 MFA (${result.method})`)
    const mfa = process.env.GARMIN_MFA
    if (mfa) {
      const tokens = await client.completeMfa(mfa)
      console.log(`✓ MFA 完成！用户: ${tokens.displayName}`)
    } else {
      console.log('  设置 GARMIN_MFA=<验证码> 完成 MFA')
    }
  }
}

main().catch((e) => {
  console.error('测试失败:', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
