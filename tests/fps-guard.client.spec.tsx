import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'
import { useFpsGuard } from '../src/client/useFpsGuard.ts'

const observers: Array<{ connected: boolean }> = []
afterEach(() => {
  cleanup()
  observers.length = 0
  vi.unstubAllGlobals()
})
function Probe({ text }: { text: string }) {
  const guard = useFpsGuard(false)
  return <div ref={guard.ref}>{text}</div>
}
it('keeps one visibility observer through rerenders and StrictMode effect replay', () => {
  vi.stubGlobal('IntersectionObserver', class {
    connected = false
    constructor() { observers.push(this) }
    observe() { this.connected = true }
    disconnect() { this.connected = false }
  })
  const view = render(<StrictMode><Probe text="first" /></StrictMode>)
  expect(observers.filter(observer => observer.connected)).toHaveLength(1)
  const count = observers.length
  view.rerender(<StrictMode><Probe text="updated" /></StrictMode>)
  expect(observers).toHaveLength(count)
  expect(observers.filter(observer => observer.connected)).toHaveLength(1)
  view.unmount()
  expect(observers.every(observer => !observer.connected)).toBe(true)
})

/**
 * The frame-rate monitor rides the shared document clock: it reads frames the
 * reveal already drives, and it must never be the reason a frame runs. While a
 * reply streams, both the reveal and the follow engine are parked between
 * chunks, so a monitor that re-arms itself keeps a 60 Hz clock alive through an
 * idle tool call and burns the CPU it is supposed to protect.
 */
it('does not keep the shared clock armed on its own', () => {
  let nextHandle = 1
  const pending = new Map<number, FrameRequestCallback>()
  let rafCalls = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafCalls += 1
    const handle = nextHandle++
    pending.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle)
  })
  const frame = (now: number) => {
    const due = [...pending.values()]
    pending.clear()
    for (const callback of due) callback(now)
  }

  const coordinator = FrameCoordinator.forDocument(document)
  coordinator.shutdown()
  function Streaming() {
    const guard = useFpsGuard(true)
    return <div ref={guard.ref} />
  }

  const view = render(<Streaming />)
  expect(rafCalls).toBe(1)

  // The monitor reads its first frame and asks for no other one: the shared
  // clock parks with the task still registered.
  frame(1000)
  expect(coordinator.taskCount).toBe(1)
  expect(coordinator.active).toBe(false)
  expect(rafCalls).toBe(1)

  // A reveal write re-arms the clock. The wide gap that the parked clock leaves
  // is not a dropped frame, so the monitor re-bases and parks again instead of
  // feeding 10 fps into the EMA and holding back commits.
  coordinator.markLayoutDirty()
  expect(rafCalls).toBe(2)
  frame(9000)
  expect(coordinator.active).toBe(false)
  expect(rafCalls).toBe(2)

  view.unmount()
  expect(coordinator.taskCount).toBe(0)
})
