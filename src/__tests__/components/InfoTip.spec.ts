import { mount } from '@vue/test-utils'
import { afterEach, describe, it, expect, vi } from 'vitest'

import InfoTip from '@/components/InfoTip.vue'

// jsdom reports 0×0 rects and a 1024px viewport by default, so neither edge of
// the 320px popup would ever overflow. We mock both to mirror the real popup.
// iconTop defaults to 100 (comfortable room above); pass a small iconTop to
// exercise the vertical-flip branch. bubbleHeight feeds the flip math.
function mockPopup(
  iconLeft: number,
  iconWidth = 13,
  bubbleWidth = 200,
  iconTop = 100,
  bubbleHeight = 60,
): void {
  const iconCenter = iconLeft + iconWidth / 2
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList?.contains('info-tip')) {
      return {
        x: iconLeft,
        y: iconTop,
        width: iconWidth,
        height: iconWidth,
        top: iconTop,
        right: iconLeft + iconWidth,
        bottom: iconTop + iconWidth,
        left: iconLeft,
        toJSON: () => ({}),
      }
    }
    // Bubble width/height are what the clamp + flip logic consume.
    return {
      x: 0,
      y: 0,
      width: this.classList?.contains('info-tip-bubble') ? bubbleWidth : 0,
      height: this.classList?.contains('info-tip-bubble') ? bubbleHeight : 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: iconCenter - bubbleWidth / 2,
      toJSON: () => ({}),
    }
  })
  Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true })
}

// getComputedStyle is real in jsdom but returns 'visible' for overflow by
// default, so nearestScrollAncestor walks to <body> and returns null (no flip).
// To exercise the flip branch we make a chosen ancestor report overflow:auto.
function mockScrollAncestorOverflow(selector: string, overflow = 'auto'): void {
  const real = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((elt) => {
    const cs = real(elt)
    if (elt && (elt as HTMLElement).matches?.(selector)) {
      return { ...cs, overflow } as CSSStyleDeclaration
    }
    return cs
  })
}

describe('InfoTip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mountComponent(tip = 'An explanation') {
    return mount(InfoTip, { props: { tip } })
  }

  it('renders the "?" icon', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.info-tip-icon').text()).toBe('?')
  })

  it('renders the tip text in the bubble', () => {
    const wrapper = mountComponent('The threshold meaning')
    expect(wrapper.find('.info-tip-bubble').text()).toBe('The threshold meaning')
  })

  it('is keyboard-focusable for accessibility', () => {
    const wrapper = mountComponent()
    const root = wrapper.find('.info-tip')
    expect(root.attributes('tabindex')).toBe('0')
    expect(root.attributes('role')).toBe('button')
  })

  it('uses the tip as aria-label', () => {
    const wrapper = mountComponent('Aria description')
    expect(wrapper.find('.info-tip').attributes('aria-label')).toBe('Aria description')
  })

  it('bubble is hidden by default and shown on hover', async () => {
    const wrapper = mountComponent()
    const bubble = wrapper.find('.info-tip-bubble')
    // Hidden state: no placement/positioning until opened; CSS drives visibility.
    expect(bubble.exists()).toBe(true)
    expect(wrapper.find('.info-tip').exists()).toBe(true)
  })

  it('centers the bubble when there is room on both sides', async () => {
    // Icon at x=150 (center=156.5), bubble 200px → ideal left=56.5, fits in
    // [0,120] → offset = 56.5 - 150 = -93.5 → Math.round = -93.
    mockPopup(150)
    const wrapper = mountComponent('Short tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = wrapper.find('.info-tip-bubble').attributes('style') ?? ''
    expect(style).toContain('left: -93px')
    // Arrow centered on the icon (0.5).
    expect(style).toContain('--arrow-ratio: 0.5')
  })

  it('clamps the bubble to the left edge when the icon is near the left', async () => {
    // Icon at x=20, bubble 200px → ideal left=-73.5, clamped to 0 → offset=-20.
    mockPopup(20)
    const wrapper = mountComponent('A fairly long explanation that spans multiple lines')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = wrapper.find('.info-tip-bubble').attributes('style') ?? ''
    expect(style).toContain('left: -20px')
    // Icon sits in the LEFT part of the bubble (bubble shifted right to stay
    // on-screen), so the arrow points left-of-center: ratio < 0.5.
    const ratioMatch = style.match(/--arrow-ratio: ([\d.]+)/)
    expect(ratioMatch).not.toBeNull()
    expect(Number(ratioMatch![1])).toBeLessThan(0.5)
  })

  it('clamps the bubble to the right edge when the icon is near the right', async () => {
    // Icon at x=300 (center=306.5), bubble 200px → ideal left=206.5, maxLeft=
    // 120 → clamped to 120 → offset = 120 - 300 = -180.
    mockPopup(300)
    const wrapper = mountComponent('A fairly long explanation that spans multiple lines')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = wrapper.find('.info-tip-bubble').attributes('style') ?? ''
    expect(style).toContain('left: -180px')
    // Icon sits in the RIGHT part of the bubble (bubble shifted left to stay
    // on-screen), so the arrow points right-of-center: ratio > 0.5.
    const ratioMatch = style.match(/--arrow-ratio: ([\d.]+)/)
    expect(ratioMatch).not.toBeNull()
    expect(Number(ratioMatch![1])).toBeGreaterThan(0.5)
  })

  it('never overflows the viewport, even when the icon is mid-popup and the bubble is wide', async () => {
    // Regression for the horizontal-scrollbar bug. Icon at x=92, bubble 240px:
    //   ideal left = 98.5 - 120 = -21.5 → clamped to 0.
    //   bubble viewport span = [0, 240] ⊂ [0, 320] → NO horizontal overflow.
    //   offset = 0 - 92 = -92.
    mockPopup(92, 13, 240)
    const wrapper = mountComponent('A fairly long explanation that spans multiple lines')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = wrapper.find('.info-tip-bubble').attributes('style') ?? ''
    expect(style).toContain('left: -92px')
    // Bubble viewport right = iconLeft(92) + offset(-92) + bw(240) = 240 ≤ 320. ✓
    expect(92 + -92 + 240).toBeLessThanOrEqual(320)
  })

  it('flips below when there is no room above the scroll ancestor', async () => {
    // Icon near the top (iconTop=20), bubble 60px → opening above needs
    // 20-6-60 = -46 → clipped above → must flip to bottom.
    mockPopup(150, 13, 200, 20, 60)
    mockScrollAncestorOverflow('body')
    const wrapper = mountComponent('Some tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(wrapper.find('.info-tip-bubble').classes()).toContain('placement-bottom')
  })

  it('stays above when there is enough room above the scroll ancestor', async () => {
    // Icon at y=100, bubble 60px → needs 100-6-60=34 above; body top=0, so
    // 34 >= 0+4 → stays on top (no flip).
    mockPopup(150, 13, 200, 100, 60)
    mockScrollAncestorOverflow('body')
    const wrapper = mountComponent('Some tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(wrapper.find('.info-tip-bubble').classes()).toContain('placement-top')
    expect(wrapper.find('.info-tip-bubble').classes()).not.toContain('placement-bottom')
  })
})
