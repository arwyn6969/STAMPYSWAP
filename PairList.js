import React from 'react';

const PairList = ({ pairs }) => {
  return (
    <ul>
      {pairs.map((pair, index) => (
        <li key={index}>{pair}</li>
      ))}
    </ul>
  );
};

export default PairList;
