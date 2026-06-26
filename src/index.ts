import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-monetary'
import zhCN from './locales/zh-CN.yml'
import enUS from './locales/en-US.yml'

export const name = 'sign-bing'

// 声明依赖的服务
export const inject = ['database', 'monetary', 'http']

export interface Config {
  enableQQNativeMarkdown: boolean
  botName: string
  rewardMin: number
  rewardMax: number
  currency: string
  platformMultipliers: Record<string, number>
}

export const Config: Schema<Config> = Schema.object({
  enableQQNativeMarkdown: Schema.boolean().default(false).description('是否在 QQ 平台启用原生 Markdown 格式发送并附加快捷签到按钮'),
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

interface QQSendMessageRequest {
  content: string
  msg_type: 2
  msg_id?: string
  msg_seq?: number
  markdown: { content: string }
  keyboard?: any
}

interface QQSessionBridge {
  sendMessage(channelId: string, data: QQSendMessageRequest): Promise<unknown>
  sendPrivateMessage(openid: string, data: QQSendMessageRequest): Promise<unknown>
}

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
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)

  // 注册数据库字段
  ctx.model.extend('user', {
    signLastDate: 'string',
    signTotal: { type: 'unsigned', initial: 0 },
    signContinuous: { type: 'unsigned', initial: 0 },
    favorability: { type: 'unsigned', initial: 0 },
  })

  // 随机数辅助函数
  const random = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

  const sendQQMarkdown = async (session: any, title: string, md: string, buttonLabel: string) => {
    const keyboard = {
      content: {
        rows: [{
          buttons: [
            { id: '1', render_data: { label: buttonLabel, style: 1 }, action: { type: 2, permission: { type: 2 }, data: '/sign', enter: true } }
          ]
        }]
      }
    };
    const internal = session.bot?.internal as QQSessionBridge | undefined;
    if (internal) {
      session['seq'] = session['seq'] || 0;
      const msgSeq = ++session['seq'];
      const payload: QQSendMessageRequest = {
        content: title,
        msg_type: 2,
        msg_id: session.messageId,
        msg_seq: msgSeq,
        markdown: { content: md },
        keyboard: keyboard
      };
      try {
        if (session.isDirect) {
          await internal.sendPrivateMessage(session.channelId, payload);
        } else {
          await internal.sendMessage(session.channelId, payload);
        }
        return true;
      } catch (e) {
        ctx.logger('sign-bing').warn('QQ native markdown send failed, fallback to text', e);
      }
    }
    return false;
  }

  ctx.command('sign')
    .example('sign')
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
        if (config.enableQQNativeMarkdown && session.platform === 'qq') {
          const md = session.text('.qqAlreadySignedMarkdown', { botName: h.escape(config.botName) })
          const sent = await sendQQMarkdown(session, session.text('.qqTitlePrompt'), md, session.text('.qqButtonSign'))
          if (sent) return '';
        }
        return session.text('.alreadySigned', { botName: config.botName })
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

      // 计算好感
      const favorAdd = random(2, 6)
      user.favorability += favorAdd

      const [todayUsers, rankedUsers] = await Promise.all([
        ctx.database.get('user', { signLastDate: todayStr }, ['id']),
        ctx.database.get('user', {}, { fields: ['id', 'signTotal', 'signContinuous'], sort: { signTotal: 'desc', id: 'asc' } }),
      ])
      const todayOrder = todayUsers.length
      const totalRank = rankedUsers.findIndex(item => item.id === user.id) + 1
      const continuousRank = [...rankedUsers]
        .sort((a, b) => b.signContinuous - a.signContinuous || a.id - b.id)
        .findIndex(item => item.id === user.id) + 1

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
        greeting = session.text('.greeting.first')
        tail = session.text('.tail.first', { userName, botName })
      } else if (isBroken) {
        greeting = session.text('.greeting.broken')
        tail = session.text('.tail.broken', { userName, botName, signTotal: user.signTotal })
      } else {
        greeting = session.text('.greeting.continuous')
        tail = session.text('.tail.continuous', { userName, botName, signContinuous: user.signContinuous, signTotal: user.signTotal })
      }

      const msgList = [
        greeting,
        session.text('.praying'),
        session.text('.signOrder', { value: todayOrder }),
        session.text('.totalRank', { value: totalRank }),
        session.text('.continuousRank', { value: continuousRank }),
        session.text('.favorAdd', { value: favorAdd }),
        session.text('.favorCurrent', { value: user.favorability }),
        session.text('.reward', { reward, currency: config.currency }),
        '',
        tail
      ]

      if (bingImage) {
        msgList.push(`\n${session.text('.scenery', { location: bingLocation })}`)
        msgList.push(h.image(bingImage).toString())
      }

      if (config.enableQQNativeMarkdown && session.platform === 'qq') {
        let md = `### 📅 ${session.text('.qqTitleResult')}\n\n`
        md += greeting.split('\n').map(line => `> ${line}`).join('\n') + `\n\n`;
        md += `- ${session.text('.signOrder', { value: todayOrder })}\n`;
        md += `- ${session.text('.totalRank', { value: totalRank })}\n`;
        md += `- ${session.text('.continuousRank', { value: continuousRank })}\n`;
        md += `- ${session.text('.favorAdd', { value: favorAdd })}\n`;
        md += `- ${session.text('.favorCurrent', { value: user.favorability })}\n`;
        md += `- ${session.text('.reward', { reward, currency: config.currency })}\n\n`;
        if (bingImage) {
          md += `> ${session.text('.qqScenery', { location: bingLocation })}\n`;
          md += `![${bingLocation} #1920px #1080px](${bingImage})\n\n`;
        }
        md += tail.split('\n').map(line => `> ${line}`).join('\n');

        const sent = await sendQQMarkdown(session, session.text('.qqTitleResult'), md, session.text('.qqButtonSign'))
        if (sent) return '';
      }

      return msgList.join('\n')
    })
}
