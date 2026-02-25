import axios from 'axios';
import * as fs from 'fs';

async function main() {
  try {
    const res = await axios.get('https://tokenscan.io/asset/RAREPEPE');
    const html = res.data;
    fs.writeFileSync('rarepepe_ts.html', html);
    
    // Find lines around Official Card Indicator
    const lines = html.split('\n');
    const idx = lines.findIndex(l => l.includes('Official Card Indicator'));
    if (idx !== -1) {
        console.log(lines.slice(idx - 2, idx + 15).join('\n'));
    }
  } catch(e) {
    console.log('FAILED', e.message);
  }
}
main();
