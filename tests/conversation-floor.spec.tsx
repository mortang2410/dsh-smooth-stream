import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { keepConversationFloor } from '../src/client/teleprompterGlide.ts'

/**
 * Callbacks registered through the stubbed `ResizeObserver`.
 *
 * The keeper builds one page-wide observer on its first call and keeps it, so a
 * later stub instance never replaces it. Every construction pushes here instead,
 * which keeps the keeper's callback reachable from every case in this file.
 */
const observers: ResizeObserverCallback[] = []

class CapturingResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observers.push(callback)
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A conversation scrollport with one content box under it.
 *
 * @param scrollHeight - Starting content height, in px.
 * @param clientHeight - Viewport height the port reports.
 * @returns The port, its content box, and a `grow` that delivers new height.
 */
function portWith(scrollHeight: number, clientHeight = 100) {
  const port = document.createElement('div')
  port.setAttribute('data-conversation-scroll', '')
  const content = document.createElement('div')
  port.appendChild(content)
  document.body.appendChild(port)
  let height = scrollHeight
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
  const grow = (next: number): void => {
    height = next
    for (const callback of observers) {
      callback([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    }
  }
  return { port, content, grow }
}

it('keeps following when the engine rests a few pixels above its floor', () => {
  const { port, content, grow } = portWith(500)
  port.scrollTop = 400
  keepConversationFloor(content)

  // The engine's own write lands on the floor, so its ledger holds this top.
  grow(520)
  expect(port.scrollTop).toBe(420)

  // Live residue: the port comes to rest 27px above the floor this engine
  // wrote, and nothing tells the keeper who moved it.
  port.scrollTop = 393
  port.dispatchEvent(new Event('scroll'))
  expect(port.scrollTop).toBe(393)

  // One chunk taller than the viewport arrives.
  grow(640)
  expect(port.scrollTop).toBe(540)

  // The next chunk follows too: a hold here used to last for the session.
  grow(760)
  expect(port.scrollTop).toBe(660)
})

it('leaves a position this engine never wrote alone', () => {
  const { port, content, grow } = portWith(500)
  // The host restored a reader position 30px above the floor.
  port.scrollTop = 370
  keepConversationFloor(content)

  grow(620)
  expect(port.scrollTop).toBe(370)
})

it('follows a chunk taller than the viewport when the port drifted before any write', () => {
  const { port, content, grow } = portWith(500)
  port.scrollTop = 400
  keepConversationFloor(content)

  // The keeper has written nothing for this port yet, so the only record it has
  // is the floor it saw at attach. A 27px drift then hides the growth.
  port.scrollTop = 373
  grow(620)
  expect(port.scrollTop).toBe(520)
})

it('lands on the new floor after the viewing height shrank', () => {
  const { port, content, grow } = portWith(1000, 600)
  port.scrollTop = 400
  keepConversationFloor(content)
  // The engine writes the floor it can see.
  grow(1010)
  expect(port.scrollTop).toBe(410)

  // The viewport shrinks while the port keeps the top the engine wrote, so the
  // floor it was holding is now 100px below that top.
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: 500 })
  // A growth wider than the new viewport arrives.
  grow(1600)
  expect(port.scrollTop).toBe(1100)
})

it('keeps a reader position the keeper saw the reader take', () => {
  const { port, content, grow } = portWith(500)
  port.scrollTop = 400
  keepConversationFloor(content)
  grow(520)
  expect(port.scrollTop).toBe(420)

  port.dispatchEvent(new WheelEvent('wheel', { deltaY: -60 }))
  port.scrollTop = 393
  port.dispatchEvent(new Event('scroll'))

  grow(640)
  expect(port.scrollTop).toBe(393)
})
