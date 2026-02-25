import axios from 'axios';

async function main() {
  const urls = [
    'https://tokenscan.io/api/collections',
    'https://tokenscan.io/api/v1/collections',
    'https://api.tokenscan.io/collections',
    'https://api.tokenscan.io/v1/collections',
    'https://tokenscan.io/api/assets',
    'https://tokenscan.io/api/rarepepe'
  ];
  
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 3000 });
      console.log(url, 'SUCCESS', res.status);
      console.log('Sample:', typeof res.data === 'object' ? Object.keys(res.data) : typeof res.data);
    } catch(e) {
      console.log(url, 'FAILED', e.response?.status || e.message);
    }
  }
}
main();
