import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-monetary'

export const name = 'sign-bing'

// 声明依赖的服务
export const inject = ['database', 'monetary', 'http']

export interface Config {
  botName: string
  rewardMin: number
  rewardMax: number
  currency: string
  platformMultipliers: Record<string, number>
}

export const Config: Schema<Config> = Schema.object({
  botName: Schema.string().default('天气酱').description('机器人的自称（会显示在签到文案中）'),
  rewardMin: Schema.number().default(30).description('基础签到货币奖励随机下限'),
  rewardMax: Schema.number().default(80).description('基础签到货币奖励随机上限'),
  currency: Schema.string().default('default').description('使用的货币名称，对应 monetary 插件的配置'),
  platformMultipliers: Schema.dict(Schema.number()).default({
    onebot: 1,
    qq: 3,
    red: 3,
  }).description('不同平台的奖励倍率，未配置的平台默认为 1 倍（例如：qq 配置为 3，则QQ端签到获得3倍奖励）'),
})

// 扩展 Koishi 的 User 表结构
declare module 'koishi' {
  interface User {
    signLastDate: string
    signTotal: number
    signContinuous: number
    favorability: number
  }
}

export function apply(ctx: Context, config: Config) {
  // 注册数据库字段
  ctx.model.extend('user', {
    signLastDate: 'string',
    signTotal: { type: 'unsigned', initial: 0 },
    signContinuous: { type: 'unsigned', initial: 0 },
    favorability: { type: 'unsigned', initial: 0 },
  })

  // 随机数辅助函数
  const random = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

  ctx.command('sign', '每日签到')
    .alias('签到')
    .userFields(['id', 'signLastDate', 'signTotal', 'signContinuous', 'favorability'])
    .action(async ({ session }) => {
      const user = session.user
      
      // 使用东八区时间判断日期，防止服务器时区不同导致的问题
      const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const todayStr = beijingTime.toISOString().split('T')[0]
      const yesterdayTime = new Date(Date.now() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000)
      const yesterdayStr = yesterdayTime.toISOString().split('T')[0]

      if (user.signLastDate === todayStr) {
        return `你今天已经和${config.botName}见过面啦，明天再来签到吧！`
      }

      // 签到状态判断
      const isFirstTime = user.signTotal === 0
      let isBroken = false
      
      if (isFirstTime) {
        user.signContinuous = 1
      } else if (user.signLastDate === yesterdayStr) {
        user.signContinuous += 1
      } else {
        isBroken = true
        user.signContinuous = 1
      }

      // 更新签到数据
      user.signTotal += 1
      user.signLastDate = todayStr

      // 计算随机运势与好感
      const luckWealth = random(1, 100)
      const luckCareer = random(1, 100)
      const luckRomance = random(1, 100)
      const favorAdd = random(2, 6)
      user.favorability += favorAdd

      // 货币奖励发放
      const platform = session.platform
      const multiplier = config.platformMultipliers[platform] ?? 1
      const baseReward = random(config.rewardMin, config.rewardMax)
      const reward = Math.floor(baseReward * multiplier)
      
      try {
        await ctx.monetary.gain(user.id, reward, config.currency)
      } catch (e) {
        ctx.logger('sign-bing').warn('发放货币奖励失败，请检查 monetary 服务配置', e)
      }

      // 获取 Bing 壁纸
      let bingImage = ''
      let bingLocation = '未知地点'
      try {
        // 请求 Bing 官方接口获取壁纸数据
        const bingData = await ctx.http.get('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN')
        if (bingData?.images?.[0]) {
          const image = bingData.images[0]
          // 替换获取超清 1080p 图片链接
          bingImage = `https://www.bing.com${image.url}`
          bingLocation = image.copyright
        }
      } catch (e) {
        ctx.logger('sign-bing').warn('获取 Bing 壁纸失败', e)
      }

      // 组装文案
      let greeting = ''
      let tail = ''
      const botName = h.escape(config.botName)
      const userName = h.escape(session.author?.name || session.username || '你')

      if (isFirstTime) {
        greeting = `“初次见面！很高兴认识你呀～”\n“以后每天都要来找我玩哦！”`
        tail = `&lt;${userName}&gt;与${botName}相遇了！这是你们相遇的第1天，期待明天的再会呢\n&lt;${userName}&gt;总共陪伴了${botName} 1 个日出与日落～`
      } else if (isBroken) {
        greeting = `“呜…好几天没看到你了，我还以为你把我忘了呢…”\n“下次不许再这样无故失踪啦！”`
        tail = `&lt;${userName}&gt;前几天似乎忘记了什么…总之重新开始连续陪着${botName}度过了 1 天，希望明天不要再忘记了吧…\n&lt;${userName}&gt;总共陪伴了${botName} ${user.signTotal} 个日出与日落～`
      } else {
        greeting = `“又见面啦！你真的很守信呢～”\n“明天、后天、大后天，也要一直在这里碰面哦！”`
        tail = `&lt;${userName}&gt;已经陪着${botName}连续度过了 ${user.signContinuous} 天，期待明天的相遇呢\n&lt;${userName}&gt;总共陪伴了${botName} ${user.signTotal} 个日出与日落～`
      }

      const msgList = [
        greeting,
        '*少女祈祷中…*',
        `『财运』: ${luckWealth}点`,
        `『事业运』: ${luckCareer}点`,
        `『桃花运』: ${luckRomance}点`,
        `『好感增加』: ${favorAdd}点`,
        `『当前好感』: ${user.favorability}点`,
        `『获得奖励』: ${reward} 货币`,
        '',
        tail
      ]

      if (bingImage) {
        msgList.push(`\n[今日风景: ${bingLocation}]`)
        msgList.push(h.image(bingImage).toString())
      }

      return msgList.join('\n')
    })
}