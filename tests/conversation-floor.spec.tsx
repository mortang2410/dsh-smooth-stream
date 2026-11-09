import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepConversationFloor, useConversationFollow } from '../src/client/teleprompterGlide.ts'

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

describe('mutation-driven follow corrections', () => {
  /**
   * The engine reads its own clock through the faked globals, so a case has to
   * drive frames explicitly; the point of this block is that no frame is
   * advanced before the assertion.
   */
  const FAKE = [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'performance',
  ] as const

  function FollowMount() {
    const rootRef = useRef<HTMLDivElement>(null)
    const speedCpsRef = useRef(100)
    useConversationFollow(rootRef, true, speedCpsRef)
    return (
      <div ref={rootRef} data-chat-transcript>
        Streamed answer
      </div>
    )
  }

  function translateOf(element: HTMLElement): number {
    return Number(
      /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('corrects a structural mutation in the same task, before any frame runs', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowMount />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => baseHeight })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: 0,
          bottom: 80 + translateOf(transcript),
        }) as DOMRect,
    )
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      top: 96,
      bottom: 176,
    } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(600))

    // A row lands and the port grows, which is the burst the mutation observer
    // exists for. Only microtasks are allowed to run: no frame, no timer.
    baseHeight += 28
    act(() => {
      transcript.appendChild(document.createElement('div'))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The follower is at the new floor already: the correction ran with the
    // mutation. A correction deferred to requestAnimationFrame would still read
    // the old top here, because no frame has run.
    expect(port.scrollTop).toBe(baseHeight - 100)

    // The next frame must inherit the corrected position, not produce it.
    let seenAtFrame = Number.NaN
    requestAnimationFrame(() => {
      seenAtFrame = port.scrollTop
    })
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(seenAtFrame).toBe(baseHeight - 100)
  })
})
