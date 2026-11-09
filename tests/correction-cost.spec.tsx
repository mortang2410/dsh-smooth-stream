import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationFollow } from '../src/client/teleprompterGlide.ts'

/**
 * Cost of one mutation burst in the follow engine.
 *
 * The engine's mutation observer corrects follow geometry once per batch. Each
 * correction reads layout, which is the expensive part on a long transcript.
 * This measures how many layout reads one burst of N child-list mutations
 * causes, so a coalescing change can be compared against the same burst.
 *
 * Not a wall-clock benchmark: jsdom has no layout, so the number that matters
 * here is the read count, and the elapsed figure is only a sanity bound.
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

const ROWS = 200
const MUTATIONS = 12

function FollowMount() {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(100)
  useConversationFollow(rootRef, true, speedCpsRef)
  return (
    <div ref={rootRef} data-chat-transcript>
      {Array.from({ length: ROWS }, (_, index) => (
        <div key={index} data-chat-flow-key={`row-${index}`}>
          row {index}
        </div>
      ))}
    </div>
  )
}

describe('mutation burst cost', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports the layout reads one burst causes', async () => {
    const view = render(
      <div data-conversation-scroll>
        <FollowMount />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 600 })
    let height = 900
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => height })
    port.scrollTop = 300
    await act(() => vi.advanceTimersByTimeAsync(600))

    const layoutReads = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const started = performance.now()

    // Twelve sibling insertions inside one frame, the shape a reveal burst
    // takes. Each one also grows the content, so the floor moves and a
    // correction that never runs is visible in the scroll position.
    for (let index = 0; index < MUTATIONS; index += 1) {
      act(() => {
        height += 28
        const row = document.createElement('div')
        row.textContent = `burst ${index}`
        transcript.appendChild(row)
      })
      await act(async () => {
        await Promise.resolve()
      })
      if (index === 0) {
        // Only microtasks have run, so no animation frame can have touched the
        // port: the observer correction itself has to have landed the new
        // floor. A broken observer leaves the old top here.
        expect(port.scrollTop).toBe(height - 600)
      }
      await act(() => vi.advanceTimersByTimeAsync(1))
    }
    await act(() => vi.advanceTimersByTimeAsync(16))

    // Fake clock: this is twelve 1 ms steps plus one 16 ms frame, not wall time.
    const elapsed = performance.now() - started
    const reads = layoutReads.mock.calls.length
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ mutations: MUTATIONS, layoutReads: reads, elapsedMs: Math.round(elapsed) }))

    // One correction per frame means the burst cannot cost a read per mutation.
    expect(reads).toBeLessThan(MUTATIONS)
  })
})
