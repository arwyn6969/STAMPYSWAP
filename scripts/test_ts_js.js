import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://tokenscan.io/js/tokenscan.js');
    const js = res.data;
    
    // Extract any api routes mentioned in the JS
    const apiMatches = js.match(/\/api\/[^"'\s>]+/g) || [];
    console.log('API routes found in JS:', [...new Set(apiMatches)]);

    // Check for rarepepe or collections
    const rpMatches = js.match(/rarepepe/ig);
    console.log('Rarepepe mentions in JS:', rpMatches ? rpMatches.length : 0);

  } catch(e) {
    console.log('Error:', e.message);
  }
}
main();
