export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

  const AIRGL_MINT = 'DSKtJFsrGycfuuEJFgsxpPrME1vrT4LfaAgTyDyeE7Vf';

  try {
    // 1. Récupérer les tokens
    const rpcResp = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [wallet, { mint: AIRGL_MINT }, { encoding: 'jsonParsed' }]
      })
    });
    const rpcData = await rpcResp.json();
    const accounts = rpcData?.result?.value || [];
    let totalTokens = 0;
    accounts.forEach(acc => {
      const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      totalTokens += amount;
    });

    // 2. Récupérer le prix via DexScreener
    let tokenPriceUsd = 0;
    try {
      const dsResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${AIRGL_MINT}`);
      const dsData = await dsResp.json();
      const pairs = dsData?.pairs || [];
      const raydiumPair = pairs.find(p => p.dexId === 'raydium') || pairs[0];
      tokenPriceUsd = parseFloat(raydiumPair?.priceUsd || 0);
    } catch(e) { tokenPriceUsd = 0; }

    const usdValue = totalTokens * tokenPriceUsd;
    const isPremium = usdValue >= 10;

    return res.status(200).json({ isPremium, totalTokens, usdValue, tokenPriceUsd });

  } catch(error) {
    console.error('Premium check error:', error);
    return res.status(500).json({ error: 'Internal server error', isPremium: false });
  }
}
