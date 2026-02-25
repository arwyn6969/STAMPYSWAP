import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://tokenscan.io/');
    const html = res.data;
    
    // Extract any api routes mentioned in the HTML
    const apiMatches = html.match(/\/api\/[^"'\s>]+/g) || [];
    console.log('API routes found in HTML:', [...new Set(apiMatches)]);
    
    const scriptMatches = html.match(/src="([^"]+\.js)"/g) || [];
    console.log('JS scripts:', scriptMatches);
  } catch(e) {
    console.log('Error:', e.message);
  }
}
main();
