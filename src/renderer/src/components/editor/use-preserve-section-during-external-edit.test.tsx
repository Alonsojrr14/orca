// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePreserveSectionDuringExternalEdit } from './usePreserveSectionDuringExternalEdit'

let now = 0
let nextFrame = 0
const frames = new Map<number, FrameRequestCallback>()

function Preview({ content }: { content: string }) {
  const body = useRef<HTMLDivElement>(null)
  const rendered = usePreserveSectionDuringExternalEdit(content, body)
  return <div ref={body}>{rendered}</div>
}

beforeEach(() => {
  now = 0
  nextFrame = 0
  frames.clear()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

function select(node: Node | null, collapsed = false) {
  const selection = window.getSelection()
  if (!node || !selection) {
    throw new Error('Expected a selectable preview text node')
  }
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, collapsed ? 0 : 3)
  selection.removeAllRanges()
  selection.addRange(range)
}

function fixture() {
  const view = render(<Preview content="initial selected text" />)
  return {
    ...view,
    update(content: string, time: number) {
      now = time
      view.rerender(<Preview content={content} />)
    },
    frame(time: number) {
      now = time
      const pending = [...frames.values()]
      frames.clear()
      act(() => {
        for (const callback of pending) {
          callback(time)
        }
      })
    },
    select: () => select(view.container.firstChild?.firstChild ?? null)
  }
}

it('applies the latest external source by the original deadline during continuous edits', () => {
  const view = fixture()
  view.select()
  for (let step = 1; step <= 3; step++) {
    view.update(`external-${step}`, step * 1000)
    view.frame(step * 1000)
    expect(view.container.textContent).toBe('initial selected text')
    expect(frames.size).toBe(1)
  }
  view.frame(3999)
  expect(view.container.textContent).toBe('initial selected text')
  view.update('external-4', 4000)
  view.frame(4000)
  expect(view.container.textContent).toBe('external-4')
  expect(frames.size).toBe(0)
  view.select()
  view.update('next episode', 4500)
  view.frame(7499)
  expect(view.container.textContent).toBe('external-4')
  view.frame(7500)
  expect(view.container.textContent).toBe('next episode')
})

it('starts a fresh deadline after source reversion and releases the latest edit on selection release', () => {
  const view = fixture()
  view.select()
  view.update('discarded source', 1000)
  view.update('initial selected text', 2000)
  expect(frames.size).toBe(0)
  view.update('fresh pending source', 2500)
  view.frame(4000)
  expect(view.container.textContent).toBe('initial selected text')
  view.frame(5500)
  expect(view.container.textContent).toBe('fresh pending source')
  view.select()
  view.update('first pending source', 6000)
  view.update('latest pending source', 6500)
  window.getSelection()?.removeAllRanges()
  view.frame(6500)
  expect(view.container.textContent).toBe('latest pending source')
  expect(frames.size).toBe(0)
  view.select()
  view.update('pending at close', 7000)
  expect(frames.size).toBe(1)
  view.unmount()
  expect(frames.size).toBe(0)
})

it.each(['none', 'collapsed', 'outside'])('updates immediately with %s selection', (kind) => {
  const view = fixture()
  const outside = document.body.appendChild(document.createTextNode('outside selection'))
  try {
    if (kind !== 'none') {
      select(
        kind === 'outside' ? outside : (view.container.firstChild?.firstChild ?? null),
        kind === 'collapsed'
      )
    }
    view.update('latest immediate source', 1000)
    expect(view.container.textContent).toBe('latest immediate source')
    expect(frames.size).toBe(0)
  } finally {
    outside.remove()
  }
})
