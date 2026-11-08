import type { AgentReply, CrawlPlan } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import type { AgentMethod } from '@/engine/driver'
import type { PageAgent } from '@/page/agent'

export interface AgentBridge {
  call<T>(tabId: number, method: AgentMethod, plan: CrawlPlan): Promise<T>
}

/** Chrome reports injection failures only as text, so they are told apart by wording. */
export function classifyInjectionError(error: unknown): CrawlError {
  const message = error instanceof Error ? error.message : String(error)
  if (/error page/iu.test(message)) return new CrawlError('NAVIGATION_FAILED', undefined, { cause: error })
  if (/no tab with id|tab was closed|frame .*removed|no frame|document .*(?:unloaded|gone)/iu.test(message)) {
    return new CrawlError('PAGE_GONE', undefined, { cause: error })
  }
  if (/cannot access|extensions gallery|cannot be scripted/iu.test(message)) {
    return new CrawlError('URL_BLOCKED', '浏览器不允许访问此页面', { cause: error })
  }
  return new CrawlError('INTERNAL', message, { cause: error })
}

/** Serialised into the page, so it can only use its arguments. */
function invoke(method: AgentMethod, plan: CrawlPlan) {
  const agent = (globalThis as unknown as { __awCrawler?: PageAgent }).__awCrawler
  return agent ? agent[method](plan) : null
}

async function runInPage<T>(tabId: number, method: AgentMethod, plan: CrawlPlan): Promise<AgentReply<T> | null> {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: invoke, args: [method, plan] })
  return (frame?.result ?? null) as AgentReply<T> | null
}

/**
 * Calls the agent, loading it first when missing. A navigation between two calls replaces the
 * document and the agent with it, so a miss is expected and is fixed by injecting again.
 */
export const agentBridge: AgentBridge = {
  async call<T>(tabId: number, method: AgentMethod, plan: CrawlPlan): Promise<T> {
    let reply: AgentReply<T> | null
    try {
      reply = await runInPage<T>(tabId, method, plan)
      if (!reply) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['agent.js'] })
        reply = await runInPage<T>(tabId, method, plan)
      }
    } catch (error) {
      throw classifyInjectionError(error)
    }
    if (!reply) throw new CrawlError('PAGE_GONE')
    if (!reply.ok) throw new CrawlError(reply.code, reply.message)
    return reply.value
  },
}
