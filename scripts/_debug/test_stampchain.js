async function main() {
  try {
    const res = await fetch('https://stampchain.io/api/v2/collections');
    if (res.ok) {
       console.log('/collections:', await res.json());
    } else {
       console.log('/collections failed:', res.status, res.statusText);
    }
  } catch(e) {}
  
  try {
    const res = await fetch('https://stampchain.io/api/v2/assets/RAREPEPE');
    if (res.ok) {
       console.log('/assets/RAREPEPE:', await res.json());
    } else {
       console.log('/assets/RAREPEPE failed:', res.status, res.statusText);
    }
  } catch(e) {}
}
main();
