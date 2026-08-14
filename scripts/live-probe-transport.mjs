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

  return { openEventSocket, rpc, timeoutMs }
}
