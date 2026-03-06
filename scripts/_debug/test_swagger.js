import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://a.rarepepe.zone/swagger/v1/swagger.json');
    console.log('Swagger endpoints:', Object.keys(res.data.paths));
  } catch(e) {
    console.log('Error:', e.message);
  }
}
main();
