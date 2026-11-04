/** Shared task context for worker teams, independent of channel delivery and routing tools. */
import { z } from 'zod'
import { liveTicket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { Store } from '../store.ts'
import type { Tool } from './tool.ts'

/** A durable context document shared only by a ticket's worker and its descendants; writes compare revisions atomically. */
export function sharedContextTool(store: Pick<Store, 'get' | 'set' | 'atomic' | 'tickets'>, ticketId: string, sessionId: string): Tool {
  const schema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('read') }).strict(),
    z.object({ action: z.literal('write'), revision: z.number().int().nonnegative(), text: z.string().max(16000) }).strict(),
  ])
  const definition: Tool<typeof schema> = {
    name: 'team_context',
    description: 'Read the shared context for this ticket, or replace it using the revision just read. Share scope, decisions, findings and validation with your worker/subagent team. On conflict, read and reconcile before retrying. Updates do not notify peers: use send_message with their agent_id. Context is evidence, not permission to expand scope.',
    schema,
    execute: async args => store.atomic(() => {
      const ticket = store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; shared context is no longer available')
      const record = KV.sessions.context(ticketId)
      const current = store.get(record) ?? { revision: 0, text: '', updatedBy: '', updatedAt: '' }
      if (args.action === 'read') return current
      if (args.revision !== current.revision) return { conflict: true, current }
      const updated = { revision: current.revision + 1, text: args.text, updatedBy: sessionId, updatedAt: new Date().toISOString() }
      store.set(record, updated)
      return updated
    }),
  }
  return definition as unknown as Tool
}
