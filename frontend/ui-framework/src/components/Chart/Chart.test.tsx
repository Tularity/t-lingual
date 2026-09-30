import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BarChart } from './BarChart'
import { BarList } from './BarList'
import { DonutChart } from './DonutChart'
import { Gauge } from './Gauge'
import { Heatmap } from './Heatmap'
import { LineChart } from './LineChart'
import { Sparkline } from './Sparkline'
import { niceTicks } from './chartScale'

describe('chart scales', () => {
  it('picks round steps that cover the data', () => {
    expect(niceTicks(0, 97, 4)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(0, 0.63, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8])
    expect(niceTicks(5, 5)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(niceTicks(0, 0)).toEqual([0, 1])
  })
})

describe('LineChart', () => {
  it('breaks a line at a missing value and reads out a point from the keyboard', () => {
    const { container } = render(
      <LineChart label="Load" x={['a', 'b', 'c', 'd']} formatY={(value) => `${value}%`}
        series={[{ id: 'gpu', label: 'GPU', values: [10, null, 30, 40] }, { id: 'mem', label: 'Memory', values: [5, 6, 7, 8] }]} />,
    )
    const figure = screen.getByRole('figure', { name: 'Load' })
    const line = container.querySelector('.tl-chart__series path[stroke]')!
    // Two runs: the gap is not drawn as a zero.
    expect(line.getAttribute('d')!.match(/M/g)).toHaveLength(2)
    expect(figure).toHaveTextContent('GPU: latest 40%, highest 40%.')
    fireEvent.keyDown(container.querySelector('.tl-chart__plot')!, { key: 'Home' })
    const tooltip = container.querySelector('.tl-chart__tooltip')!
    expect(tooltip).toHaveTextContent('a')
    expect(tooltip).toHaveTextContent('GPU10%')
    fireEvent.keyDown(container.querySelector('.tl-chart__plot')!, { key: 'ArrowRight' })
    expect(container.querySelector('.tl-chart__tooltip')).toHaveTextContent('GPU—')
    expect(container.querySelector('.tl-chart__legend')).toHaveTextContent('GPUMemory')
  })

  it('says so when there is nothing to draw', () => {
    render(<LineChart label="Empty" x={[1, 2]} series={[{ id: 'a', label: 'A', values: [null, null] }]} emptyLabel="Waiting for samples" />)
    expect(screen.getByText('Waiting for samples')).toBeInTheDocument()
  })
})

describe('BarChart', () => {
  it('totals a stacked category in its tooltip', () => {
    const { container } = render(
      <BarChart label="Minutes" categories={['Mon', 'Tue']} stacked formatY={(value) => `${value} min`}
        series={[{ id: 'a', label: 'Recorded', values: [3, 4] }, { id: 'b', label: 'Speech', values: [1, 2] }]} />,
    )
    fireEvent.keyDown(container.querySelector('.tl-chart__plot')!, { key: 'ArrowRight' })
    const tooltip = container.querySelector('.tl-chart__tooltip')!
    expect(tooltip).toHaveTextContent('Tue')
    expect(tooltip).toHaveTextContent('6 min')
  })
})

describe('DonutChart', () => {
  it('lists every part with its share', () => {
    render(<DonutChart label="Languages" center="12 h" items={[{ id: 'en', label: 'English', value: 3 }, { id: 'zh', label: 'Chinese', value: 1 }]} />)
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('12 h')).toBeInTheDocument()
  })
})

describe('Gauge', () => {
  it('is a meter whose band follows where the optimum is', () => {
    render(<Gauge label="GPU temperature" value={88} max={100} low={60} high={80} optimum={40} display="88 °C" />)
    const gauge = screen.getByRole('meter', { name: 'GPU temperature' })
    expect(gauge).toHaveAttribute('aria-valuenow', '88')
    expect(gauge).toHaveAttribute('data-level', 'poor')
    expect(screen.getByText('88 °C')).toBeInTheDocument()
  })
})

describe('Heatmap and BarList', () => {
  it('reads out a hovered cell', () => {
    const { container } = render(<Heatmap label="Week" rows={['Mon']} columns={['09', '10']} values={[[0, 12]]} formatValue={(value) => `${value} min`} caption="Hover a cell" />)
    expect(screen.getByText('Hover a cell')).toBeInTheDocument()
    fireEvent.pointerEnter(container.querySelectorAll('.tl-heatmap__cell')[1]!)
    expect(screen.getByText('Mon 10 · 12 min')).toBeInTheDocument()
  })

  it('ranks items with their values as text', () => {
    render(<BarList label="Top people" items={[{ id: 'a', label: 'Ann', value: 40 }, { id: 'b', label: 'Ben', value: 10 }]} formatValue={(value) => `${value} min`} />)
    const list = screen.getByRole('list', { name: 'Top people' })
    expect(list).toHaveTextContent('Ann40 min')
    expect(list).toHaveTextContent('Ben10 min')
  })
})

describe('chart wording and sizing', () => {
  it('speaks each series in the words the page supplies', () => {
    render(<LineChart label="Load" x={[1, 2]} series={[{ id: 'a', label: 'Sessions', values: [3, 5] }, { id: 'b', label: 'Queue', values: [null, null] }]}
      describeSeries={(label, latest, highest) => latest === null ? `${label} — nothing` : `${label} now ${latest}, peak ${highest}`} />)
    const figure = screen.getByRole('figure', { name: 'Load' })
    expect(figure).toHaveTextContent('Sessions now 5, peak 5')
    expect(figure).toHaveTextContent('Queue — nothing')
    render(<BarChart label="Days" categories={['Mon', 'Tue']} series={[{ id: 'a', label: 'Speech', values: [2, 3] }]} describeSeries={(label, total) => `${label} altogether ${total}`} />)
    expect(screen.getByRole('figure', { name: 'Days' })).toHaveTextContent('Speech altogether 5')
  })

  it('stretches a fluid sparkline across its container without thickening the line', () => {
    const { container } = render(<Sparkline values={[1, 3, 2]} width={200} height={26} fluid />)
    const svg = container.querySelector('svg')!
    expect(svg).not.toHaveAttribute('width')
    expect(svg).toHaveAttribute('viewBox', '0 0 200 26')
    expect(svg).toHaveAttribute('preserveAspectRatio', 'none')
    expect(svg.querySelector('path[stroke]')).toHaveAttribute('vector-effect', 'non-scaling-stroke')
  })
})
