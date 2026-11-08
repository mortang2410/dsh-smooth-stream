/**
 * Contract the follow engine's mutation-observer dedupe relies on: every writer
 * that reveals text by rewriting Text node data tells the follower about it, so
 * the follower's pre-paint correction runs in that same task. The engine's own
 * observer skips character-data batches for exactly this reason, and a writer
 * that stays silent would let a tool row's wrap land one frame late.
 */

import { useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'

const commit = vi.fn()
vi.mock('../src/client/teleprompterGlide.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/teleprompterGlide.ts')>()
  return { ...actual, notifyFollowCommit: (root: HTMLElement | null) => { commit(root); actual.notifyFollowCommit(root) } }
})

function Probe({ text, speed }: { text: string; speed: number }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedRef = useRef(speed)
  speedRef.current = speed
  useProgressiveDomText(rootRef, true, true, speedRef)
  return <div data-progressive ref={rootRef}>{text}</div>
}

function installClock(): { frame: (now: number) => void; pending: Map<number, FrameRequestCallback> } {
  let handle = 1
  const pending = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = handle++
    pending.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id) })
  return {
    pending,
    frame(now: number): void {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, callback] of due) callback(now)
    },
  }
}

afterEach(() => {
  cleanup()
  commit.mockClear()
  vi.unstubAllGlobals()
  FrameCoordinator.forDocument().shutdown()
})

it('commits every frame that rewrites text so the follower corrects before paint', () => {
  const clock = installClock()
  FrameCoordinator.forDocument().shutdown()
  const view = render(<Probe text="alpha beta gamma delta" speed={600} />)
  const root = view.container.querySelector('[data-progressive]') as HTMLElement

  // Frame 1 lets the engine record the text; the following frames reveal it.
  clock.frame(1000)
  clock.frame(1016)
  clock.frame(1050)
  expect(commit).toHaveBeenCalled()
  for (const [called] of commit.mock.calls) expect(called).toBe(root)
})

it('commits the settle write that reveals the rest of the row', () => {
  const clock = installClock()
  FrameCoordinator.forDocument().shutdown()
  const view = render(<Probe text="alpha beta gamma delta" speed={600} />)
  const root = view.container.querySelector('[data-progressive]') as HTMLElement

  clock.frame(1000)
  clock.frame(1016)
  commit.mockClear()

  // Unmount settles every controlled node to its full text in one write, the
  // largest growth the row ever takes; the follower has to hear about it.
  view.unmount()
  expect(commit).toHaveBeenCalled()
  for (const [called] of commit.mock.calls) expect(called).toBe(root)
})
