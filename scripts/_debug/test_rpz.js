import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://rarepepe.zone/directory');
    console.log('/directory (rarepepe.zone):', res.status);
    console.log('Sample data:', Array.isArray(res.data) ? res.data.slice(0, 2) : res.data);
  } catch(e) {
    console.log('/directory failed:', e.message);
  }
}
main();
