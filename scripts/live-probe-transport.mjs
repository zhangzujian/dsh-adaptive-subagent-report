export function textContent(blocks) {
  return blocks?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

function analyzeHistory(historyEvents) {
  let openTurn
  const completed = []
  const messages = []
  for (const [index, row] of historyEvents.entries()) {
    const event = row.event
    if (event.type === 'turn/start') {
      if (openTurn !== undefined) {
        throw new Error(`session history opened turn ${event.data.turn} before closing turn ${openTurn}`)
      }
      openTurn = event.data.turn
    } else if (event.type === 'turn/end') {
      if (event.data.turn !== openTurn) {
        throw new Error(`session history ended turn ${event.data.turn} while turn ${openTurn} was open`)
      }
      completed.push(openTurn)
      openTurn = undefined
    } else if (event.type === 'user/message') {
      messages.push({ event, index, turn: openTurn })
    }
  }
  return { completed, messages }
}

export function completedTurns(historyEvents) {
  return analyzeHistory(historyEvents).completed
}

export function userMessagesWithOpenTurn(historyEvents) {
  return analyzeHistory(historyEvents).messages
}

export function createProbeTransport({ defaultTimeoutMs, rpcPrefix }) {
  const baseHttp = process.env.DSH_HTTP_URL ?? 'http://127.0.0.1:13080'
  const baseWs = baseHttp.replace(/^http/, 'ws')
  const timeoutMs = Number(process.env.DSH_PROBE_TIMEOUT_MS ?? defaultTimeoutMs)

  async function rpc(method, payload) {
    const response = await fetch(`${baseHttp}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `${rpcPrefix}-${method}-${Date.now()}`,
        method,
        payload,
      }),
    })
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`)
    const envelope = await response.json()
    if (!envelope?.result?.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(envelope?.result?.error)}`)
    }
    return envelope.result.value
  }

  function openEventSocket(eventPath, onPayload) {
    const socket = new WebSocket(`${baseWs}/api/${eventPath}`)
    socket.addEventListener('message', event => {
      const envelope = JSON.parse(String(event.data))
      onPayload(envelope.payload)
    })
    return socket
  }

  function watchSession(sessionId, { onQueue, onStatus }) {
    const sockets = [
      openEventSocket('events.mux', payload => {
        if (payload?.type === 'session/queue' && payload.sessionId === sessionId) onQueue(payload)
      }),
      openEventSocket('events.host', payload => {
        if (payload?.type === 'host/session-status' && payload.sessionId === sessionId) onStatus(payload)
      }),
    ]
    return {
      close() {
        for (const socket of sockets) socket.close()
      },
    }
  }

  return { rpc, timeoutMs, watchSession }
}
