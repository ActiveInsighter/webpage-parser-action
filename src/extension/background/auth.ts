import { requestJson } from '@/engine/api'
import { CLIENT_COLLECTION } from './config'
import type { Session, SessionUser } from './session'

interface AuthPayload {
  token: string
  record: { id: string; email?: string; name?: string }
}

function toSession(payload: AuthPayload): Session {
  const user: SessionUser = { id: payload.record.id, email: payload.record.email ?? '', name: payload.record.name ?? '' }
  return { token: payload.token, user }
}

/** The extension works as its owner: it signs in with their AnyWorkflow account. */
export async function signInWithPassword(baseUrl: string, identity: string, password: string): Promise<Session> {
  const path = `/api/collections/${CLIENT_COLLECTION}/auth-with-password`
  return toSession(await requestJson<AuthPayload>(baseUrl, path, { body: { identity, password } }))
}

export async function refreshSession(baseUrl: string, token: string): Promise<Session> {
  const path = `/api/collections/${CLIENT_COLLECTION}/auth-refresh`
  return toSession(await requestJson<AuthPayload>(baseUrl, path, { token }))
}
