import type { Settings } from '@/extension/background/settings'
import type { PopupReply, PopupRequest, StatusReply } from '@/extension/messages'

const app = document.querySelector<HTMLElement>('#app')!
let message = ''

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

async function send(request: PopupRequest): Promise<StatusReply> {
  const reply = (await chrome.runtime.sendMessage(request)) as PopupReply | undefined
  if (!reply) throw new Error('扩展后台没有响应')
  if (!reply.ok) throw new Error(reply.message)
  return reply.value
}

/** Runs a request from the UI and redraws with its outcome. */
async function act(request: PopupRequest, done = ''): Promise<void> {
  try {
    const status = await send(request)
    message = ''
    render(status, done)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
    render(await send({ type: 'status' }))
  }
}

function header(status: StatusReply): HTMLElement {
  return element('header', {}, element('h1', {}, 'AnyWorkflow 网页采集'), element('span', { className: 'muted' }, `v${status.version}`))
}

function alertLine(text: string): HTMLElement | null {
  return text ? element('p', { className: 'alert', role: 'alert' } as Partial<HTMLParagraphElement>, text) : null
}

function signInView(status: StatusReply): HTMLElement {
  const email = element('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' })
  const password = element('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })
  const submit = element('button', { type: 'submit', className: 'primary' }, '登录')
  const form = element(
    'form',
    { className: 'panel' },
    element('label', {}, '账号邮箱', email),
    element('label', {}, '密码', password),
    submit,
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit.disabled = true
    void act({ type: 'signIn', email: email.value, password: password.value })
  })
  const note = alertLine(message || status.lastError)
  if (note) form.append(note)
  return form
}

function statusLine(status: StatusReply): HTMLElement {
  const online = status.settings.enabled && !status.lastError
  const text = !status.settings.enabled ? '已暂停' : status.running ? `采集中 ${status.running} 个` : status.lastError ? '连接异常' : '等待任务'
  return element('div', { className: 'status' }, element('span', { className: online ? 'dot on' : 'dot' }), text)
}

function settingsForm(settings: Settings): HTMLElement {
  const concurrency = element('select', { name: 'concurrency' })
  for (const value of [1, 2, 3, 4]) concurrency.append(element('option', { value: String(value), selected: value === settings.concurrency }, String(value)))
  const openMode = element('select', { name: 'openMode' })
  openMode.append(
    element('option', { value: 'window', selected: settings.openMode === 'window' }, '独立窗口（渲染最完整）'),
    element('option', { value: 'tab', selected: settings.openMode === 'tab' }, '后台标签页（更安静）'),
  )
  const blocked = element('textarea', { name: 'blockedHosts', value: settings.blockedHosts.join('\n'), spellcheck: false })
  const save = element('button', { type: 'submit' }, '保存设置')
  const form = element(
    'form',
    {},
    element(
      'div',
      {},
      element('label', {}, '同时采集', concurrency),
      element('label', {}, '打开方式', openMode),
      element('label', {}, '屏蔽域名（每行一个，含子域名）', blocked),
      save,
    ),
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void act(
      {
        type: 'saveSettings',
        patch: { concurrency: Number(concurrency.value), openMode: openMode.value as Settings['openMode'], blockedHosts: blocked.value.split('\n') },
      },
      '设置已保存',
    )
  })
  return element('details', {}, element('summary', {}, '采集设置'), form)
}

function accountView(status: StatusReply, notice: string): HTMLElement {
  const enabled = element('input', { type: 'checkbox', checked: status.settings.enabled })
  enabled.addEventListener('change', () => void act({ type: 'saveSettings', patch: { enabled: enabled.checked } }))
  const crawlTab = element('button', { type: 'button', className: 'primary' }, '采集当前页')
  crawlTab.addEventListener('click', () => {
    crawlTab.disabled = true
    void act({ type: 'crawlActiveTab' }, '已加入采集队列')
  })
  const open = element('button', { type: 'button' }, '打开控制台')
  open.addEventListener('click', () => void chrome.tabs.create({ url: status.remoteUrl }))
  const signOut = element('button', { type: 'button' }, '退出')
  signOut.addEventListener('click', () => void act({ type: 'signOut' }))

  const panel = element(
    'section',
    { className: 'panel' },
    statusLine(status),
    element('span', { className: 'muted' }, status.user?.email || status.user?.id || ''),
    element('label', { className: 'inline' }, '接收任务', enabled),
    element('div', { className: 'row' }, crawlTab, open),
  )
  const note = alertLine(message || status.lastError)
  if (note) panel.append(note)
  if (notice) panel.append(element('span', { className: 'muted', role: 'status' } as Partial<HTMLSpanElement>, notice))
  return element('div', { className: 'panel' }, panel, settingsForm(status.settings), signOut)
}

function render(status: StatusReply, notice = ''): void {
  app.replaceChildren(header(status), status.user ? accountView(status, notice) : signInView(status))
}

void send({ type: 'status' }).then(render, (error: unknown) => {
  app.replaceChildren(element('p', { className: 'alert' }, error instanceof Error ? error.message : String(error)))
})
