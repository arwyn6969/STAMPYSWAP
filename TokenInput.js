import React from 'react';

const TokenInput = ({ setToken }) => {
  return (
    <input type="text" placeholder="Enter token name" onChange={(e) => setToken(e.target.value)} />
  );
};

export default TokenInput;
