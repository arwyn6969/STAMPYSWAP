import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const GR = '/usr/local/lib/node_modules'
const satori = require(`${GR}/satori`).default
const { Resvg } = require(`${GR}/@resvg/resvg-js`)
import fs from 'fs'

// Load a font satori can use (DejaVu is present on most linux images; fall back if needed)
function findFont() {
  const cands = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ]
  for (const c of cands) { if (fs.existsSync(c)) return c }
  return null
}
const fontPath = findFont()
if (!fontPath) { console.error('no font found'); process.exit(1) }
const font = fs.readFileSync(fontPath)

const chip = (t) => ({ type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '10px',
  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: '999px',
  padding: '12px 22px', fontSize: '22px', color: '#c7cede' },
  children: [ { type: 'span', props: { style: { color: '#3ddc97' }, children: '●' } }, t ] } })

const node = {
  type: 'div',
  props: {
    style: {
      width: '1200px', height: '630px', display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', padding: '72px 76px',
      background: 'linear-gradient(160deg, #0a0c12 0%, #0a0b10 60%, #06070a 100%)',
      color: '#eef1f8', fontFamily: 'DejaVu',
    },
    children: [
      { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '16px' },
        children: [
          { type: 'div', props: { style: { width: '60px', height: '60px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '34px', fontWeight: 800, color: '#1a0e00', background: 'linear-gradient(135deg, #f7931a, #ff5e3a)' }, children: '§' } },
          { type: 'div', props: { style: { fontSize: '40px', fontWeight: 800, letterSpacing: '-1px', display: 'flex' },
            children: [
              { type: 'span', props: { style: { color: '#eef1f8' }, children: 'Stampy' } },
              { type: 'span', props: { style: { color: '#f7931a' }, children: 'Swap' } },
            ] } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column' },
        children: [
          { type: 'div', props: { style: { fontSize: '82px', fontWeight: 800, letterSpacing: '-3px', lineHeight: 1.03, display: 'flex', flexDirection: 'column' },
            children: [
              { type: 'span', props: { style: { color: '#eef1f8' }, children: 'Bitcoin-native assets,' } },
              { type: 'span', props: { style: { color: '#14f195' }, children: 'liquid across chains' } },
            ] } },
          { type: 'div', props: { style: { fontSize: '29px', color: '#9aa3b8', marginTop: '26px', maxWidth: '960px', lineHeight: 1.4 },
            children: 'Deposit an SRC-20 or Counterparty asset into an Emblem Vault, mint a fully-backed representation on Solana, Base & Ethereum — trade it, then redeem back to Bitcoin.' } },
        ] } },
      { type: 'div', props: { style: { display: 'flex', gap: '14px', alignItems: 'center' },
        children: [ chip('Emblem-Vault custody'), chip('Live proof-of-reserves'), chip('No raw keys') ] } },
    ],
  },
}

const svg = await satori(node, { width: 1200, height: 630, fonts: [
  { name: 'DejaVu', data: font, weight: 700, style: 'normal' },
] })
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
fs.writeFileSync(new URL('./public/og.png', import.meta.url), png)
console.log('wrote public/og.png', png.length, 'bytes')
