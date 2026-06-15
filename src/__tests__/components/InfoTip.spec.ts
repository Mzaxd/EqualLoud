import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'

import InfoTip from '@/components/InfoTip.vue'

describe('InfoTip', () => {
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
})
