// @vitest-environment happy-dom

import { act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { resolveVisualStreamGeometry, type StreamSize } from './emulator-device-frame-layout'

type Frame = { displayWidth: number; displayHeight: number; close: () => void }
type Meta = {
  streamId: string
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}
type Packet = {
  streamId: string
  deviceId: string
  config: boolean
  keyFrame: boolean
  bytes: ArrayBuffer
}

class Decoder {
  static instances: Decoder[] = []
  state = 'unconfigured'
  readonly output: (frame: Frame) => void
  constructor(init: { output: (frame: Frame) => void }) {
    this.output = init.output
    Decoder.instances.push(this)
  }
  configure(): void {
    this.state = 'configured'
  }
  decode(): void {}
  close(): void {
    this.state = 'closed'
  }
}

let root: Root
let container: HTMLDivElement
let metaListeners: Set<(meta: Meta) => void>
let frameListeners: Set<(frame: Packet) => void>
let streamId: string
let stop: ReturnType<typeof vi.fn>
let reports: StreamSize[]
let contextDescriptor: PropertyDescriptor | undefined

function Screen({ orientation }: { orientation: 'portrait' | 'landscape' }) {
  const [size, setSize] = useState<StreamSize | null>(null)
  const onSize = useCallback((next: StreamSize) => {
    reports.push(next)
    setSize(next)
  }, [])
  const { canvasRef } = useEmulatorVideoStream('device', 'stream', true, onSize)
  const geometry = resolveVisualStreamGeometry(size, orientation)
  return (
    <canvas
      ref={canvasRef}
      data-rotation={geometry.streamRotation}
      data-size={size ? `${size.width}x${size.height}` : ''}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  Decoder.instances = []
  reports = []
  metaListeners = new Set()
  frameListeners = new Set()
  stop = vi.fn(async () => {})
  vi.stubGlobal('VideoDecoder', Decoder)
  vi.stubGlobal('EncodedVideoChunk', class {})
  contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ clearRect: vi.fn(), drawImage: vi.fn() })
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      emulator: {
        startVideoStream: async (args: { streamId: string }) => {
          streamId = args.streamId
          return args
        },
        stopVideoStream: stop,
        onVideoStreamMeta: (cb: (meta: Meta) => void) => {
          metaListeners.add(cb)
          return () => metaListeners.delete(cb)
        },
        onVideoStreamFrame: (cb: (frame: Packet) => void) => {
          frameListeners.add(cb)
          return () => frameListeners.delete(cb)
        }
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (contextDescriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', contextDescriptor)
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
  }
  Reflect.deleteProperty(window, 'api')
  vi.unstubAllGlobals()
})

async function render(orientation: 'portrait' | 'landscape' = 'portrait'): Promise<void> {
  await act(async () => {
    root.render(<Screen orientation={orientation} />)
  })
}

function metadata(): void {
  for (const cb of metaListeners) {
    cb({ streamId, deviceId: 'device', meta: { codecId: 'h264', width: 240, height: 480 } })
  }
  for (const cb of frameListeners) {
    cb({ streamId, deviceId: 'device', config: true, keyFrame: false, bytes: new ArrayBuffer(0) })
  }
}

function frame(width: number, height: number): Frame {
  const result = { displayWidth: width, displayHeight: height, close: vi.fn() }
  const decoder = Decoder.instances[0]
  expect(decoder.state).toBe('configured')
  decoder.output(result)
  return result
}

describe('Android decoded stream geometry', () => {
  it('follows decoded rotation and resolution without repeating unchanged size reports', async () => {
    await render()
    act(() => {
      metadata()
      frame(240, 480)
    })
    expect(reports).toEqual([{ width: 240, height: 480 }])
    await render('landscape')
    act(() => {
      frame(480, 240)
    })
    expect(container.querySelector('canvas')?.dataset.rotation).toBe('0')
    expect(container.querySelector('canvas')?.dataset.size).toBe('480x240')
    act(() => {
      frame(640, 320)
      for (let i = 0; i < 10; i++) {
        frame(640, 320)
      }
    })
    expect(reports).toEqual([
      { width: 240, height: 480 },
      { width: 480, height: 240 },
      { width: 640, height: 320 }
    ])
    expect(container.querySelector('canvas')?.width).toBe(640)
  })

  it('closes late decoded frames without notifying a retired screen', async () => {
    await render()
    act(() => metadata())
    const decoder = Decoder.instances[0]
    act(() => root.unmount())
    const late = { displayWidth: 480, displayHeight: 240, close: vi.fn() }
    act(() => decoder.output(late))
    expect(late.close).toHaveBeenCalledOnce()
    expect(reports).toEqual([{ width: 240, height: 480 }])
    expect(decoder.state).toBe('closed')
    expect(stop).toHaveBeenCalledOnce()
    expect(metaListeners.size).toBe(0)
    expect(frameListeners.size).toBe(0)
  })
})
