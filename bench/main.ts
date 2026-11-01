import { type Row, runAll } from './cases'
import { runLib } from './lib-cases'
import { formatUs } from './harness'

declare global {
  interface Window {
    __results?: Promise<Row[]>
  }
}

const out = document.querySelector('#out') as HTMLTableSectionElement
const logRow = (row: Row): void => console.log(`${row.group} | ${row.name} | ${row.medianUs.toFixed(2)} µs`)
const status = document.querySelector('#status') as HTMLElement
status.textContent = `${navigator.userAgent} · running…`

function show(row: Row): void {
  logRow(row)
  const tr = document.createElement('tr')
  for (const text of [row.group, row.name, formatUs(row.medianUs), formatUs(row.minUs), row.note ?? '']) {
    const td = document.createElement('td')
    td.textContent = text
    tr.append(td)
  }
  out.append(tr)
}

// Let the page paint before the first measurement.
window.__results = new Promise((r) => setTimeout(r, 100)).then(() =>
  runAll(show).then(async (rows) => {
    rows.push(...(await runLib(show)))
    status.textContent = `${navigator.userAgent} · done`
    return rows
  }),
)
