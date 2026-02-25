import axios from 'axios';

async function main() {
  const urls = [
    'https://tokenscan.io/asset/RAREPEPE',
    'https://tokenscan.io/collection/rarepepe',
    'https://tokenscan.io/project/rarepepe',
    'https://tokenscan.io/rarepepe'
  ];
  
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 3000 });
      console.log(url, 'SUCCESS', res.status);
      const html = res.data;
      // if it has a table of assets, it might be a collection page
      if (html.includes('table')) {
          console.log(' - Contains table data');
      }
    } catch(e) {
      console.log(url, 'FAILED', e.response?.status || e.message);
    }
  }
}
main();
