import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://tokenscan.io/asset/RAREPEPE', { timeout: 3000 });
    const html = res.data;
    
    // Check for "Official card in the Rare Pepe project"
    const snippetMatch = html.match(/.{0,50}Official card.{0,100}/i);
    console.log('Snippet found:', snippetMatch ? snippetMatch[0] : 'No match');
    
    // Check for other collection links
    const collectionLinks = html.match(/href="\/collection[^"]+"/g);
    console.log('Collection links:', collectionLinks);

  } catch(e) {
    console.log('FAILED', e.message);
  }
}
main();
