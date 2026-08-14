import assert from 'node:assert/strict'
import test from 'node:test'

import { completedTurns, userMessagesWithOpenTurn } from '../scripts/live-probe-transport.mjs'

function turnStart(turn) {
  return { event: { type: 'turn/start', data: { turn } } }
}

function turnEnd(turn) {
  return { event: { type: 'turn/end', data: { turn } } }
}

function userMessage(id) {
  return { event: { type: 'user/message', data: { id } } }
}

test('[version-sensitive: DSH rc.6 session history seam] attributes user messages only while their turn is open', () => {
  const events = [
    turnStart(1),
    userMessage('turn-1'),
    turnEnd(1),
    userMessage('between-turns'),
    turnStart(2),
    userMessage('recovery-prompt'),
    userMessage('recovery-report'),
    userMessage('recovery-settlement'),
    turnEnd(2),
    userMessage('after-recovery'),
  ]

  assert.deepEqual(
    userMessagesWithOpenTurn(events).map(({ event, turn }) => ({ id: event.data.id, turn })),
    [
      { id: 'turn-1', turn: 1 },
      { id: 'between-turns', turn: undefined },
      { id: 'recovery-prompt', turn: 2 },
      { id: 'recovery-report', turn: 2 },
      { id: 'recovery-settlement', turn: 2 },
      { id: 'after-recovery', turn: undefined },
    ],
  )
})

test('[version-sensitive: DSH rc.6 session history seam] excludes an open final turn from the completed boundary', () => {
  const events = [
    turnStart(1),
    turnEnd(1),
    turnStart(2),
    turnEnd(2),
    turnStart(3),
    userMessage('open-turn'),
  ]

  assert.deepEqual(completedTurns(events), [1, 2])
})
