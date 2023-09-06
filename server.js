const express = require('express');
const axios = require('axios');

const app = express();

app.get('/api/pairs/:token', async (req, res) => {
  const { token } = req.params;
  // Call XCP API to get pairs
  // ...

  res.json({ pairs: [] });
});

app.listen(3001, () => {
  console.log('Server running on http://localhost:3001');
});
