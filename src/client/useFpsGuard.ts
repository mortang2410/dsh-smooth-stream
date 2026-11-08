/**
 * Performance guard for the streaming reveal.
 *
 * Feeds an EMA-smoothed frame-rate monitor from a rAF loop while streaming
 * and tracks whether the reply is on-screen. The returned `shouldHoldBack`
 * predicate is true only while the frame rate is below the threshold AND the
 * reply is offscreen — exactly the spec's "skip offscreen DOM updates when
 * FPS < 30" rule. The smoother consumes the predicate as its commit veto.
 */

import { useCallback, useEffect, useRef } from 'react'
import { debugRuntime } from './debugRuntime.ts'
import { FrameCoordinator } from './FrameCoordinator.ts'

const FPS_THRESHOLD = 30
const FPS_ALPHA = 0.12
const RECOVER_FRAMES = 6
const MAX_FRAME_MS = 100

interface MutableFps {
  emaMs: number
  lastMs: number
  healthyRun: number
  degraded: boolean
}

export function useFpsGuard(active: boolean): {
  ref: (element: HTMLElement | null) => void
  shouldHoldBack: () => boolean
} {
  const fpsRef = useRef<MutableFps>({ emaMs: 0, lastMs: 0, healthyRun: 0, degraded: false })
  const visibleRef = useRef(true)
  const elementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    let lastDebugReport = 0
    const frame = (now: number): boolean => {
      const fps = fpsRef.current
      if (fps.lastMs === 0) {
        fps.lastMs = now
        return false
      }
      const gap = now - fps.lastMs
      // The monitor reads frames the reveal already drives; it must never be
      // the reason a frame runs. The first tick after the clock parked carries
      // the whole idle gap, which says nothing about the page's frame rate: it
      // re-bases the window rather than scoring 4 fps and holding back commits.
      // A stall the page really dropped keeps the clock armed, so the gap there
      // still counts and still trips the guard.
      if (FrameCoordinator.forDocument().resumedFromIdle) {
        fps.lastMs = now
        fps.emaMs = 0
        fps.healthyRun = 0
        fps.degraded = false
        return false
      }
      fps.lastMs = now
      const delta = Math.min(MAX_FRAME_MS, Math.max(1, gap))
      fps.emaMs = fps.emaMs === 0 ? delta : fps.emaMs + FPS_ALPHA * (delta - fps.emaMs)
      const currentFps = 1000 / fps.emaMs
      if (currentFps < FPS_THRESHOLD) {
        fps.healthyRun = 0
        fps.degraded = true
      } else if (fps.degraded) {
        fps.healthyRun += 1
        if (fps.healthyRun >= RECOVER_FRAMES) fps.degraded = false
      }
      if (now - lastDebugReport >= 100) {
        debugRuntime.reportFps(currentFps, fps.emaMs, fps.degraded)
        lastDebugReport = now
      }
      return false
    }
    // The frame-rate monitor no longer owns a rAF chain of its own: it rides
    // the shared document clock and only re-arms while the reply is streaming.
    const coordinator = FrameCoordinator.forDocument()
    const taskId = coordinator.registerTask({ onSimulate: (_dtMs, now) => frame(now) })
    return () => {
      coordinator.unregisterTask(taskId)
      fpsRef.current = { emaMs: 0, lastMs: 0, healthyRun: 0, degraded: false }
      debugRuntime.clearFps()
    }
  }, [active])

  const observerRef = useRef<IntersectionObserver | null>(null)

  const ref = useCallback((element: HTMLElement | null) => {
    elementRef.current = element
    if (observerRef.current !== null) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visibleRef.current = entry.isIntersecting
      },
      { rootMargin: '120px 0px' },
    )
    observer.observe(element)
    observerRef.current = observer
  }, [])

  useEffect(() => {
    // React 18 StrictMode replays effect cleanup without detaching the DOM ref.
    if (observerRef.current === null) ref(elementRef.current)
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [ref])

  const shouldHoldBack = useCallback(() => {
    return active && fpsRef.current.degraded && !visibleRef.current
  }, [active])

  return { ref, shouldHoldBack }
}
