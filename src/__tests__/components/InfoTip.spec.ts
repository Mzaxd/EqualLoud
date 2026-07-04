import { mount } from '@vue/test-utils'
import { afterEach, describe, it, expect, vi } from 'vitest'

import InfoTip from '@/components/InfoTip.vue'

/**
 * The 2.0 InfoTip teleports its bubble to document.body (escaping the popup's
 * overflow:hidden layers) and positions it with position:fixed against the
 * viewport. Tests therefore read the bubble from document.body, not from the
 * wrapper, and mock getBoundingClientRect + the viewport to exercise the
 * clamp/flip logic.
 */
function mockViewport(
  iconLeft: number,
  iconWidth = 13,
  bubbleWidth = 200,
  iconTop = 100,
  bubbleHeight = 60,
  vw = 320,
  vh = 600,
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
    if (this.classList?.contains('info-tip-bubble')) {
      return {
        x: iconCenter - bubbleWidth / 2,
        y: 0,
        width: bubbleWidth,
        height: bubbleHeight,
        top: 0,
        right: iconCenter + bubbleWidth / 2,
        bottom: bubbleHeight,
        left: iconCenter - bubbleWidth / 2,
        toJSON: () => ({}),
      }
    }
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }
  })
  Object.defineProperty(window, 'innerWidth', { value: vw, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: vh, configurable: true })
}

/** Read the teleported bubble from document.body (it's outside the wrapper). */
function bubbleEl(): HTMLElement {
  return document.body.querySelector('.info-tip-bubble') as HTMLElement
}

describe('InfoTip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function mountComponent(tip = 'An explanation') {
    return mount(InfoTip, { props: { tip } })
  }

  it('renders the "?" icon', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.info-tip-icon').text()).toBe('?')
  })

  it('does not render the bubble in the component tree (it teleports to body on open)', () => {
    const wrapper = mountComponent('The threshold meaning')
    // The bubble is v-if-gated on `open`; before hover it is not in the DOM at all.
    expect(wrapper.find('.info-tip-bubble').exists()).toBe(false)
    expect(document.body.querySelector('.info-tip-bubble')).toBeNull()
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

  it('mounts the bubble to document.body on hover', async () => {
    mockViewport(150)
    const wrapper = mountComponent('Short tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(bubbleEl()).not.toBeNull()
    expect(bubbleEl().textContent).toBe('Short tip')
  })

  it('positions the bubble with fixed viewport coordinates (left clamp + center)', async () => {
    // Icon at x=150 (center=156.5), bubble 200px → ideal left=56.5, fits in
    // [0, 120] → left = 56.5 → round 57.
    mockViewport(150)
    const wrapper = mountComponent('Short tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = bubbleEl().getAttribute('style') ?? ''
    expect(style).toContain('left: 57px')
    // Arrow points at the icon center (156.5 - 57 = 99.5 → round 100).
    expect(style).toContain('--arrow-x: 100px')
  })

  it('clamps the bubble to the left edge when the icon is near the left', async () => {
    // Icon at x=20 (center=26.5), bubble 200px → ideal left=-73.5, clamped to 0.
    mockViewport(20)
    const wrapper = mountComponent('A fairly long explanation')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = bubbleEl().getAttribute('style') ?? ''
    expect(style).toContain('left: 0px')
    // Icon (26.5) sits in the LEFT part of the bubble [0,200], so the arrow
    // offset (26.5 - 0 = 26.5) is well below center.
    expect(style).toContain('--arrow-x: 27px')
  })

  it('clamps the bubble to the right edge when the icon is near the right', async () => {
    // Icon at x=300 (center=306.5), vw=320, bubble 200px → ideal left=206.5,
    // maxLeft=120 → clamped to 120. Icon offset within bubble = 306.5-120=186.5.
    mockViewport(300)
    const wrapper = mountComponent('A fairly long explanation')
    await wrapper.find('.info-tip').trigger('mouseenter')
    const style = bubbleEl().getAttribute('style') ?? ''
    expect(style).toContain('left: 120px')
    // Arrow points right-of-center: 306.5 - 120 = 186.5.
    expect(style).toContain('--arrow-x: 187px')
  })

  it('flips below when there is no room above in the viewport', async () => {
    // Icon at top=20, bubble 60px → opening above needs 20-6-60=-46 < 4 → flip.
    mockViewport(150, 13, 200, 20, 60)
    const wrapper = mountComponent('Some tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(bubbleEl().classList.contains('placement-bottom')).toBe(true)
  })

  it('stays above when there is enough room above in the viewport', async () => {
    // Icon at top=100, bubble 60px → needs 100-6-60=34 above; 34 >= 4 → stays.
    mockViewport(150, 13, 200, 100, 60)
    const wrapper = mountComponent('Some tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(bubbleEl().classList.contains('placement-top')).toBe(true)
    expect(bubbleEl().classList.contains('placement-bottom')).toBe(false)
  })

  it('removes the bubble from the DOM on mouseleave', async () => {
    mockViewport(150)
    const wrapper = mountComponent('Short tip')
    await wrapper.find('.info-tip').trigger('mouseenter')
    expect(bubbleEl()).not.toBeNull()
    await wrapper.find('.info-tip').trigger('mouseleave')
    expect(document.body.querySelector('.info-tip-bubble')).toBeNull()
  })
})
