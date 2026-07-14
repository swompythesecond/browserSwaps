// USDT -> ETH auto-refill for the relayer (Arbitrum One, Uniswap V3).
//
// The relayer earns its fees in USDT but pays gas in ETH, so left alone its
// ETH balance drains while USDT piles up. This module watches the ETH balance
// and, when it dips below a low watermark, swaps a capped slice of the
// accumulated USDT back to ETH so the gas station keeps itself fuelled.
//
// It is DISABLED by default. Turn it on with AUTOREFILL=on (env or .env) once
// you're comfortable letting the relayer trade its own USDT. Every parameter
// below is env-overridable, every action is logged, and each swap is bounded
// by REFILL_MAX_USDT and slippage-protected against a live Uniswap quote.
//
// Safety notes:
//   • Keep REFILL_MIN_ETH high enough that there's always gas left to pay for
//     the approve + swap themselves (the default 0.0008 ETH is plenty on L2).
//   • The swap sells at most REFILL_MAX_USDT per refill, no more often than
//     REFILL_COOLDOWN_MS, and never below REFILL_RESERVE_USDT held back.
//   • If the Uniswap quote reverts (pool/fee-tier wrong, no liquidity), the
//     refill is skipped rather than executed blind.
import { parseEther, formatEther, formatUnits } from 'viem';

// --- Arbitrum One addresses (same across mainnet deployments) --------------
const WETH9 = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const WETH_ABI = [
  ...ERC20_ABI,
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
];

const ROUTER_ABI = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [{
    type: 'tuple', name: 'params', components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}];

const QUOTER_ABI = [
  {
    name: 'quoteExactOutputSingle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      type: 'tuple', name: 'params', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      type: 'tuple', name: 'params', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
];

/**
 * @param {object} deps
 * @param {import('viem').PublicClient} deps.client
 * @param {import('viem').WalletClient} deps.wallet
 * @param {import('viem').Account} deps.account
 * @param {`0x${string}`} deps.token   USDT address
 * @param {(fn: () => Promise<any>) => Promise<any>} [deps.exclusive]  serialize wallet sends
 * @param {object} env  process.env-like map (env wins over .env fallback)
 */
export function createAutoRefill({ client, wallet, account, token, exclusive }, env = {}) {
  const send = exclusive ?? ((fn) => fn()); // serialize with relay ops when provided
  const get = (k, d) => (env[k] ?? process.env[k] ?? d);
  const enabled = String(get('AUTOREFILL', 'off')).toLowerCase() === 'on';

  const cfg = {
    minEth: parseEther(String(get('REFILL_MIN_ETH', '0.0008'))),
    targetEth: parseEther(String(get('REFILL_TARGET_ETH', '0.003'))),
    maxUsdt: BigInt(get('REFILL_MAX_USDT_UNITS', '5000000')),        // 5 USDT
    reserveUsdt: BigInt(get('REFILL_RESERVE_USDT_UNITS', '0')),
    slippageBps: BigInt(get('REFILL_SLIPPAGE_BPS', '100')),          // 1%
    poolFee: Number(get('REFILL_POOL_FEE', '500')),                  // 0.05% tier
    cooldownMs: Number(get('REFILL_COOLDOWN_MS', String(5 * 60_000))),
  };

  let lastAttempt = 0;
  let running = false;
  let refills = 0;
  let lastError = null;

  async function approveIfNeeded(amountIn) {
    const allowance = await client.readContract({
      address: token, abi: ERC20_ABI, functionName: 'allowance',
      args: [account.address, SWAP_ROUTER_02],
    });
    if (allowance >= amountIn) return;
    // Approve a generous allowance once so future refills need no approval.
    // First approval is from 0, so no USDT zero-reset dance is required.
    const approveAmount = 1_000_000_000_000n; // 1,000,000 USDT
    const hash = await send(() => wallet.writeContract({
      address: token, abi: ERC20_ABI, functionName: 'approve',
      args: [SWAP_ROUTER_02, approveAmount],
    }));
    await client.waitForTransactionReceipt({ hash });
    console.log('[autorefill] approved USDT -> SwapRouter02');
  }

  /** Live Uniswap quote (QuoterV2 is non-view; eth_call it via simulate). */
  async function quoteUsdtForEth(ethOut) {
    const { result } = await client.simulateContract({
      address: QUOTER_V2, abi: QUOTER_ABI, functionName: 'quoteExactOutputSingle',
      args: [{ tokenIn: token, tokenOut: WETH9, amount: ethOut, fee: cfg.poolFee, sqrtPriceLimitX96: 0n }],
      account,
    });
    return result[0]; // amountIn USDT
  }

  async function quoteEthForUsdt(usdtIn) {
    const { result } = await client.simulateContract({
      address: QUOTER_V2, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: token, tokenOut: WETH9, amountIn: usdtIn, fee: cfg.poolFee, sqrtPriceLimitX96: 0n }],
      account,
    });
    return result[0]; // amountOut WETH
  }

  /**
   * Top the relayer's ETH back up if it's low. Fire-and-forget: callers should
   * NOT await this on a request path. Never throws.
   */
  async function maybeRefill() {
    if (!enabled || running) return;
    if (Date.now() - lastAttempt < cfg.cooldownMs) return;
    running = true;
    lastAttempt = Date.now();
    try {
      const eth = await client.getBalance({ address: account.address });
      if (eth >= cfg.minEth) return; // still fuelled

      const usdt = await client.readContract({
        address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      });
      const spare = usdt > cfg.reserveUsdt ? usdt - cfg.reserveUsdt : 0n;
      if (spare <= 0n) {
        console.warn(`[autorefill] ETH low (${formatEther(eth)}) but no spare USDT to swap`);
        return;
      }

      // Size the swap to reach the target, capped by budget and spare balance.
      const needEth = cfg.targetEth - eth;
      const usdtForNeed = await quoteUsdtForEth(needEth);
      let amountIn = usdtForNeed;
      if (amountIn > cfg.maxUsdt) amountIn = cfg.maxUsdt;
      if (amountIn > spare) amountIn = spare;
      if (amountIn <= 0n) return;

      // Slippage floor from a live quote for exactly what we'll sell.
      const expectedOut = await quoteEthForUsdt(amountIn);
      const minOut = (expectedOut * (10_000n - cfg.slippageBps)) / 10_000n;

      await approveIfNeeded(amountIn);

      console.log(`[autorefill] ETH ${formatEther(eth)} < ${formatEther(cfg.minEth)}; swapping ${formatUnits(amountIn, 6)} USDT -> ~${formatEther(expectedOut)} ETH`);

      // 1) USDT -> WETH to our own address (SwapRouter02 struct has no deadline).
      const swapHash = await send(() => wallet.writeContract({
        address: SWAP_ROUTER_02, abi: ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{
          tokenIn: token, tokenOut: WETH9, fee: cfg.poolFee,
          recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        }],
      }));
      await client.waitForTransactionReceipt({ hash: swapHash });

      // 2) Unwrap all WETH we now hold -> native ETH.
      const weth = await client.readContract({
        address: WETH9, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address],
      });
      if (weth > 0n) {
        const unwrapHash = await send(() => wallet.writeContract({
          address: WETH9, abi: WETH_ABI, functionName: 'withdraw', args: [weth],
        }));
        await client.waitForTransactionReceipt({ hash: unwrapHash });
      }

      refills++;
      lastError = null;
      const newEth = await client.getBalance({ address: account.address });
      console.log(`[autorefill] done. ETH now ${formatEther(newEth)} (refill #${refills})`);
    } catch (e) {
      lastError = e.shortMessage ?? e.message;
      console.warn('[autorefill] skipped:', lastError);
    } finally {
      running = false;
    }
  }

  if (enabled) {
    console.log(`[autorefill] ON — keep ETH >= ${formatEther(cfg.minEth)}, top up to ${formatEther(cfg.targetEth)}, max ${formatUnits(cfg.maxUsdt, 6)} USDT/refill, ${Number(cfg.slippageBps) / 100}% slippage, pool ${cfg.poolFee}`);
  }

  return {
    enabled,
    maybeRefill,
    status: () => ({ enabled, refills, lastError, minEth: formatEther(cfg.minEth), targetEth: formatEther(cfg.targetEth) }),
  };
}
