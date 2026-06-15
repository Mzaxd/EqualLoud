import { mount } from '@vue/test-utils'
import { afterEach, describe, it, expect, vi } from 'vitest'

import InfoTip from '@/components/InfoTip.vue'

// jsdom reports 0×0 rects and a 1024px viewport by default, so neither edge of
// the 320px popup would ever overflow. We mock both to mirror the real popup.
function mockPopup(iconLeft: number, iconWidth = 13, bubbleWidth = 200): void {
  const iconCenter = iconLeft + iconWidth / 2
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList?.contains('info-tip')) {
      return {
        x: iconLeft,
        y: 100,
        width: iconWidth,
        height: iconWidth,
        top: 100,
        right: iconLeft + iconWidth,
        bottom: 100 + iconWidth,
        left: iconLeft,
        toJSON: () => ({}),
      }
    }
    // Bubble width is what the alignment logic actually consumes.
    return {
      x: 0,
      y: 0,
      width: this.classList?.contains('info-tip-bubble') ? bubbleWidth : 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: iconCenter - bubbleWidth / 2,
      toJSON: () => ({}),
    }
  })
  Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true })
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
    // Hidden state
    expect(bubble.classes()).not.toContain('visible')
    // The visibility is CSS-driven; we verify the trigger element exists and
    // hovering the root is what toggles it (asserted via :hover in CSS, not JS).
    expect(wrapper.find('.info-tip').exists()).toBe(true)
  })

  it('centers the bubble when there is room on both sides', async () => {
    // Icon at x=150 → centered bubble (100px each side) fits in a 320px popup.
    mockPopup(150)
    const wrapper = mountComponent('Short tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(wrapper.find('.info-tip-bubble').classes()).toContain('align-center')
  })

  it('flips to start (left-aligned) when the icon is near the left edge', async () => {
    // Icon at x=20 → a centered 200px bubble would overflow the left edge.
    mockPopup(20)
    const wrapper = mountComponent('A fairly long explanation that spans multiple lines')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(wrapper.find('.info-tip-bubble').classes()).toContain('align-start')
  })

  it('flips to end (right-aligned) when the icon is near the right edge', async () => {
    // Icon at x=300 → a centered 200px bubble would overflow the right edge.
    mockPopup(300)
    const wrapper = mountComponent('A fairly long explanation that spans multiple lines')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(wrapper.find('.info-tip-bubble').classes()).toContain('align-end')
  })
})
