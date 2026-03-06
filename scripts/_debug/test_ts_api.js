async function main() {
  try {
    const res = await fetch('https://tokenscan.io/api/asset/RAREPEPE');
    console.log('/api/asset/RAREPEPE:', res.status, (await res.json()).projects);
  } catch(e) { console.log('Error 1', e); }
  
  try {
    const res = await fetch('https://tokenscan.io/api/asset/FAUXCORNCASH');
    console.log('/api/asset/FAUXCORNCASH:', res.status, (await res.json()).projects);
  } catch(e) { console.log('Error 2', e); }
}
main();
