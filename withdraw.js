async function withdraw() {
  const url = 'https://api.onswitch.xyz/developer/withdraw';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-service-key': 'Lp8Rm2vXwukfpLtf7NgPuuiKJw'
  };
  const body = JSON.stringify({
    asset: 'solana:usdc',
    beneficiary: {
      wallet_address: '8hM6fCeFrBZAenN8HdQDZ6qN7G5Yv8qu34VJFy95mejh'
    }
  });

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}

withdraw();
