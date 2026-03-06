import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://stampchain.io/api/v2/collections');
    console.log('/collections:', res.status, res.data);
  } catch(e) {
    console.log('/collections failed:', e.response?.status || e.message);
  }
  
  try {
    const res = await axios.get('https://stampchain.io/api/v2/assets/RAREPEPE');
    console.log('/assets/RAREPEPE:', res.status, res.data);
  } catch(e) {
    console.log('/assets/RAREPEPE failed:', e.response?.status || e.message);
  }
}
main();
