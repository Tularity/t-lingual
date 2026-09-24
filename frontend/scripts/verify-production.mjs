import { readdir, readFile } from 'node:fs/promises'

const forbidden = ['t-lingual:development-data', 't-lingual:mock-auth', 'ws://mock.invalid']
const files = (await readdir(new URL('../dist/assets/', import.meta.url))).filter(name => name.endsWith('.js'))
if (!files.length) throw new Error('No production JavaScript was built')
for (const file of files) {
  const source = await readFile(new URL(`../dist/assets/${file}`, import.meta.url), 'utf8')
  if (forbidden.some(marker => source.includes(marker))) throw new Error(`Development API was bundled into ${file}`)
}
console.log('Production bundle verified: development API and storage are absent.')
