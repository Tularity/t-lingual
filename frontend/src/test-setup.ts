import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })

// jsdom has no media decoder; transport tests explicitly drive media events.
Object.defineProperty(HTMLMediaElement.prototype,'pause',{configurable:true,value:vi.fn()})
