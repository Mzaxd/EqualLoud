// src/__tests__/gain-slew.spec.ts
import { describe, it, expect } from 'vitest'

import { GainSlew } from '@/audio/gain-slew'

describe('GainSlew', () => {
  it('holds at the current level on the first call (no dt yet)', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    expect(slew.next(24, 1000)).toBe(0)
  })

  it('limits rise to maxRiseDbPerSec across consecutive calls', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(24, 0) // 第一拍 dt=0 → 保持 0
    expect(slew.next(24, 100)).toBeCloseTo(2) // 20 dB/s × 0.1 s
    expect(slew.next(24, 350)).toBeCloseTo(7) // +5 dB over 0.25 s
    expect(slew.next(24, 600)).toBeCloseTo(12)
  })

  it('stops exactly at target once reached', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(8, 0)
    slew.next(8, 500) // 20×0.5=10 > 8 → 封顶到目标
    expect(slew.next(8, 600)).toBe(8)
  })

  it('lets decreases through instantly', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 })
    slew.next(10, 0)
    slew.next(10, 400) // 爬到 +8
    expect(slew.next(-3, 401)).toBe(-3)
  })

  it('caps a huge wall-clock gap to maxStepMs worth of rise', () => {
    const slew = new GainSlew({ maxRiseDbPerSec: 20 }) // 默认 maxStepMs=500
    slew.next(24, 0)
    slew.next(24, 100)
    // 挂后台 60 s 后回来：只按 500 ms 记账 → 2 + 20×0.5 = 12
    expect(slew.next(24, 61_100)).toBeCloseTo(12)
  })

  it('keeps instances independent', () => {
    const a = new GainSlew({ maxRiseDbPerSec: 20 })
    const b = new GainSlew({ maxRiseDbPerSec: 20 })
    a.next(20, 0)
    a.next(20, 100)
    expect(a.next(20, 200)).toBeCloseTo(4)
    expect(b.next(-60, 200)).toBe(-60) // b 未被 a 影响
  })
})
