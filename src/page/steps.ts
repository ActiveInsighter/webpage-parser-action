import { WARNINGS, type Step } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import { click, queryAll, removeAll } from './ops/dom'
import { autoScroll } from './ops/scroll'
import { budget, sleep } from './ops/time'
import { waitForQuiet, waitWithin } from './ops/wait'

const DEFAULT_WAIT_MS = 10_000

export interface StepOutcome {
  warnings: string[]
  log: string[]
}

async function runStep(step: Step, deadline: number): Promise<string> {
  switch (step.op) {
    case 'wait': {
      const element = await waitWithin(deadline, step.selector, step.timeoutMs ?? DEFAULT_WAIT_MS)
      if (!element) throw new CrawlError('STEP_FAILED', `等待元素超时：${step.selector}`)
      return `wait ${step.selector}`
    }
    case 'sleep':
      await sleep(budget(deadline, step.ms))
      return `sleep ${step.ms}`
    case 'settle': {
      const quiet = await waitForQuiet({ quietMs: step.quietMs, minChars: step.minChars, timeoutMs: budget(deadline, step.timeoutMs ?? 5_000) })
      return `settle ${quiet ? 'quiet' : 'busy'}`
    }
    case 'scroll':
      return `scroll ${await autoScroll({ maxRounds: step.maxRounds, pauseMs: step.pauseMs, deadline })} rounds`
    case 'click': {
      const matches = queryAll(step.selector)
      if (!matches.length) throw new CrawlError('STEP_FAILED', `没有可点击的元素：${step.selector}`)
      let clicked = 0
      for (const element of step.all ? matches : matches.slice(0, 1)) {
        budget(deadline)
        if (click(element)) clicked += 1
        await sleep(step.pauseMs ?? 200)
      }
      return `click ${clicked}`
    }
    case 'remove':
      return `remove ${removeAll(step.selector)}`
  }
}

/** Runs steps in order. `optional` steps degrade to a warning; anything else ends the job. */
export async function runSteps(steps: readonly Step[], deadline: number): Promise<StepOutcome> {
  const warnings: string[] = []
  const log: string[] = [`page ${document.visibilityState}`]
  for (const step of steps) {
    try {
      log.push(await runStep(step, deadline))
    } catch (error) {
      const optional = 'optional' in step && step.optional
      if (!optional || !(error instanceof CrawlError) || error.code !== 'STEP_FAILED') throw error
      warnings.push(WARNINGS.stepSkipped)
      log.push(`skip ${step.op}: ${error.message}`)
    }
  }
  return { warnings: [...new Set(warnings)], log }
}
