import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultLocalPreferences, type LocalPreferences } from '../../app/preferences'
import { AudioCaptureSettings } from './AudioCaptureSettings'

describe('microphone capture controls', () => {
  it('switches between clean native capture and call-compatible browser processing', async () => {
    const user = userEvent.setup()
    let current: LocalPreferences = defaultLocalPreferences
    const onChange = vi.fn((next: LocalPreferences) => { current = next; view.rerender(<AudioCaptureSettings value={current} onChange={onChange} />) })
    const view = render(<AudioCaptureSettings value={current} onChange={onChange} />)
    expect(screen.getByRole('radio', { name: /Studio/ })).toBeChecked()
    expect(screen.getByRole('slider', { name: 'Microphone level' })).toHaveValue('12.5')
    expect(screen.getByRole('slider', { name: 'Microphone level' })).toHaveAttribute('max', '16')
    await user.click(screen.getByRole('radio', { name: /Communication/ }))
    expect(current).toMatchObject({ captureMode: 'communication', echoCancellation: true, noiseSuppression: true, microphoneGain: 2 })
    expect(screen.getByRole('radio', { name: /Communication/ })).toBeChecked()
    fireEvent.change(screen.getByRole('slider', { name: 'Microphone level' }), { target: { value: '2.5' } })
    expect(current.microphoneGain).toBe(2.5)
    expect(screen.getByText(/Bluetooth headset may use its system call-quality profile/)).toBeInTheDocument()
  })
  it('disables all processing controls during a save', () => {
    render(<AudioCaptureSettings value={defaultLocalPreferences} onChange={vi.fn()} disabled />)
    expect(screen.getByRole('radio', { name: /Studio/ })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Microphone level' })).toBeDisabled()
  })
})
