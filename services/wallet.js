//const bigdecimal = require("bigdecimal");
const moment = require("moment");
const {
  chainCoins,
  debank_chain_details,
  debank_protocol_ref,
  COMPOUNDING_TOKENS,
  CovalentPrices,
} = require("../constant");
const FAST_MODE = true;
const timeCost = {
  ercTokenPrice: {
    timeCost: 0,
    count: 0,
  },
  nativeCoinPrice: {
    timeCost: 0,
    count: 0,
  },
  getTransData: {
    timeCost: 0,
    count: 0,
  },
  tokenCostBasis: {
    timeCost: 0,
    count: 0,
  },
  get_debank_token: {
    timeCost: 0,
    count: 0,
  },
  makeTokenResult: {
    timeCost: 0,
    count: 0,
  },
};

const {
  getCurrentBlockNumber,
  getTokenBalances,
  getTokenTransfers,
  getTransactions,
  getTokenPrice,
  getAssets,
  getDebankValue,
  getCovalentPrice,
} = require("../helpers/moralis");

const {
  getTokenInfoByDebank,
  getDeBankComplexProtocol,
  getSupplyTokens,
  get_debank_token,
  poolKey,
  reward_tokens,
} = require("../helpers/debank");

const Utils = require("../utils");
const REF_ASSETS = require("./../data/vfat_all.json");
const debank_protocol_tags = require("./../data/debank/protocol_list.json");
const MODE_SETTING = require("./../config").CONFIG.mode;

const global_cache = {};

async function getWalletsCostHistory(wallet_data, job) {
  const global_token_info_debank = await getTokenInfoByDebank(
    wallet_data.wallet
  );
  const global_complex_protocol_debank = await getDeBankComplexProtocol(
    wallet_data.wallet
  );

  // global_token_info_debank = global_token_info_debank.filter(
  //   (x) => !COMPOUNDING_TOKENS[x.id]
  // );

  const wallet_positions = global_token_info_debank.filter(
    (position) => position.is_verified || position.protocol_id != ""
  ); //Skip spam tokens

  const resultData = [];
  const resultFootnotes = [];
  let i = 0;

  let status_job = {
    part: [],
    total: wallet_positions.length,
  };

  const arr = [];

  for (const chain in chainCoins) {
    //if (chain != "fantom") continue;
    if (wallet_data.jobChain && wallet_data.jobChain != chain) {
      continue;
    }

    status_job.part.push({
      current: 0,
      total: 0,
      chain: chainCoins[chain].name_network,
    });

    job.progress(status_job);

    const balances = global_token_info_debank.filter(
      (item) => item.chain == chainCoins[chain].chainId
    );

    if (balances.length == 0) continue;

    const complex = global_complex_protocol_debank.filter(
      (item) => item.chain == chainCoins[chain].chainId
    );

    arr.push(
      getWalletCostBasis(
        {
          chain,
          wallet: wallet_data.wallet,
          jobProtocol: wallet_data.jobProtocol
        },
        balances,
        complex,
        {
          job,
          status: status_job.part[i],
          part: i++,
        }
      )
    );
  }

  try {
    const res = await Promise.all(arr);

    res.forEach((item) => {
      resultData.push(...item.data);
      resultFootnotes.push(...item.footnotes);
    });
  } catch (e) {
    console.log("get wallet cost basis error", e);
    return null;
  }

  //Sort results across chains, largest to smallest value
  resultData.sort((a, b) => (a.value > b.value ? -1 : 1));
  //console.log("Footnotes", resultFootnotes);
  return { footnotes: resultFootnotes, result: resultData };
}

//Mark "Borrow" transfers
//   For transactions that have:
//   Two transfers in same direction +
//   one of them is a coin being borrowed
//      (on borrow_coin_list in complex_protocol)
function markBorrowTransfers(
  global_complex_protocol_debank,
  global_transfers,
  wallet
) {
  //Find coins being borrowed
  const portfolio_items = global_complex_protocol_debank.flatMap(
    (protocol) => protocol.portfolio_item_list
  );
  const portfolio_items_borrowing = portfolio_items.filter(
    (item) => item.detail.borrow_token_list
  );
  const borrow_tokens = portfolio_items_borrowing.flatMap(
    (item) => item.detail.borrow_token_list
  );
  const borrow_token_ids = borrow_tokens.flatMap((token) => token.id);

  //Loop through transfers in these coins
  const borrow_token_transfers = global_transfers.filter((xfer) =>
    borrow_token_ids.includes(xfer.address)
  );
  for (let i = 0; i < borrow_token_transfers.length; i++) {
    const tx = borrow_token_transfers[i].transaction_hash;
    const transfers_in_tx = global_transfers.filter(
      (xfer) => xfer.transaction_hash == tx
    );
    if (transfers_in_tx.length != 2) continue;
    const to_vault = transfers_in_tx.find(
      (xfer) => xfer.from_address == wallet
    );
    const from_vault = transfers_in_tx.find(
      (xfer) => xfer.to_address == wallet
    );
    if (to_vault && from_vault) continue;

    //If they fit the criteria, mark them as "borrow" transactions
    transfers_in_tx.forEach((xfer) => {
      xfer.type = "borrow";
    });
  }
  return global_transfers;
}

function prepTransfers(
  global_transfers,
  global_tx,
  global_complex_protocol_debank,
  chain,
  wallet
) {
  //Filter out compounding tokens
  // global_transfers = global_transfers.filter(
  //   (x) => !COMPOUNDING_TOKENS[x.address]
  // );

  //Convert strings to numbers
  for (let i = 0; i < global_transfers.length; i++) {
    global_transfers[i].value = BigInt(global_transfers[i]?.value);
    global_transfers[i].block_number = Number(
      global_transfers[i]?.block_number
    );
    global_transfers[i].to_address =
      global_transfers[i]?.to_address.toLowerCase();
    global_transfers[i].from_address =
      global_transfers[i]?.from_address.toLowerCase();
  }

  //Add receipts for one-way vault deposits/withdrawals
  global_transfers = add_vault_transfers(
    chain,
    wallet,
    global_transfers,
    global_complex_protocol_debank
  );

  //Copy native inbound transfers
  global_transfers = inbound_native_transfers(global_transfers, chain, wallet);

  //Copy native outbound transfers to ERC20 transfers
  const native_xfers = global_tx.filter((xfer) => xfer.value > 0);
  for (let i = 0; i < native_xfers.length; i++) {
    const tx = native_xfers[i];

    global_transfers.push({
      address: chainCoins[chain].address,
      block_hash: tx.block_hash,
      block_number: tx.block_number,
      block_timestamp: tx.block_timestamp,
      from_address: tx.from_address,
      to_address: tx.to_address,
      transaction_hash: tx.hash,
      value: BigInt(tx.value),
      gas: tx.gas,
      gas_price: tx.gas_price,
    });
  }

  //Mark "Borrow" transfers
  transfers = markBorrowTransfers(
    global_complex_protocol_debank,
    global_transfers,
    wallet
  );

  //Add isReceived
  for (let i = 0; i < global_transfers.length; i++) {
    global_transfers[i]["isReceived"] =
      global_transfers[i].to_address == wallet;
  }

  //Sort: Latest transactions first
  global_transfers = global_transfers.sort(Utils.sortBlockNumber_reverseChrono);

  console.log("global_transfers", global_transfers.length, chain);

  return global_transfers;
}

//Input: wallet vault / defi position from  debank + reference vaults from vfat tools
//Output: deposit address for vault
function getRefVault(wallet_vault, ref_assets) {
  let ref_vault = null;

  //Plan A: Match by pool key generated by debank_protocols/src/2a_analyze_debank.js
  ref_vault = ref_assets.find((v) => v.key == wallet_vault.key);
  if (ref_vault) return ref_vault;

  const ref_assets_chain_protocol = ref_assets.filter(
    (ref) =>
      ref.chain.toLowerCase() == wallet_vault.chain &&
      ref.protocol.toLowerCase() == wallet_vault.protocol_id
  );

  //Plan B: Match pool id directly
  if (wallet_vault.name == "Governance" || wallet_vault.name == "Locked") {
    ref_vault = ref_assets_chain_protocol.find(
      (ref) => ref.deposit_address == wallet_vault.pool_id.toLowerCase()
    );
  }

  //Plan C: Match on underlying tokens...
  if (!ref_vault) {
    ref_vault = ref_assets_chain_protocol.find(
      (ref) => ref.underlying_tokens_hash == wallet_vault.asset_hash
    );
  }

  //Plan D: Match on deposit tokens...
  if (!ref_vault) {
    ref_vault = ref_assets_chain_protocol.find(
      (ref) => ref.deposit_tokens_hash == wallet_vault.asset_hash
    );
  }

  return ref_vault;
}

//Prep reference vaults
function getGlobalVaults(chain) {
  //TODO: Move this to run when server starts
  let ref_assets = REF_ASSETS.filter(
    (item) => item.chain.toLowerCase() == chain
  );
  for (let i = 0; i < ref_assets.length; i++) {
    // console.log(i);
    // if (i == 86) {
    //   console.log("breakpt");
    // }
    if (ref_assets[i].deposit_tokens) {
      let deposit_tokens_hash = ref_assets[i].deposit_tokens.map((asset) =>
        asset.address.toLowerCase()
      );
      deposit_tokens_hash = deposit_tokens_hash.sort().join("|");
      ref_assets[i]["deposit_tokens_hash"] = deposit_tokens_hash;
    }

    if (ref_assets[i].underlying_tokens) {
      let underlying_tokens_hash = ref_assets[i].underlying_tokens.map(
        (asset) => asset.address?.toLowerCase()
      );
      underlying_tokens_hash = underlying_tokens_hash.sort().join("|");
      ref_assets[i]["underlying_tokens_hash"] = underlying_tokens_hash;
    }
  }
  return ref_assets;
}

//Defi vault positions in wallet
function prepWalletVaults(
  global_complex_protocol_debank,
  global_token_info_debank,
  global_balances,
  chain
) {
  let wallet_vaults = [];
  const complex = global_complex_protocol_debank.filter(
    (item) => item.chain == chain
  );

  const ref_assets = getGlobalVaults(chain);

  //Export complex_protocol into searchable vaults
  for (const complex_protocol_item of complex) {
    const portfolio_item_list = complex_protocol_item.portfolio_item_list;

    if (isDebtProtocol(complex_protocol_item.id)) continue; //AAVE2 has coins for assets + debt

    for (const pool of portfolio_item_list) {
      if (!pool.detail.supply_token_list) continue;
      if (pool.stats.net_usd_value == 0) continue;

      //Boilerplate, do for all pools
      pool.positionType = "vault";
      pool.chain = chain; //TODO: Moralis chain or DeBank chain?
      pool.protocol_id = complex_protocol_item.id;
      pool.value = pool.stats.net_usd_value;
      const supply_tokens = pool.detail.supply_token_list.map(
        (token) => token.id
      );
      pool.asset_hash = supply_tokens.sort().join("|");
      pool.key = poolKey(complex_protocol_item, pool);

      //Plan A: Look for matching LPs coins in wallet
      const pool_id = pool.pool_id.toLowerCase();
      const lp_token_debank = global_token_info_debank.find(
        (token) =>
          token.id.toLowerCase() == pool_id &&
          token.protocol_id.toLowerCase() ==
          complex_protocol_item.id.toLowerCase()
      );
      if (lp_token_debank) {
        //Found matching token in wallet
        lp_token_debank.used = true;
        pool.id = lp_token_debank.id.toLowerCase();
        const lp_token_moralis = global_balances.find(
          (token) => token.token_address.toLowerCase() == pool_id
        );
        pool.raw_amount =
          lp_token_moralis?.balance || lp_token_debank.raw_amount;
      } else {
        //Plan B: Match pool vs reference vault in JSON
        //        Vault does not give a token receipt: Search history by deposit address + maybe deposit token
        const ref_vault = getRefVault(pool, ref_assets);
        pool.id = ref_vault?.deposit_tokens[0].address.toLowerCase() || null;
        pool.deposit_address =
          ref_vault?.deposit_address?.toLowerCase() || null;
        if (ref_vault) pool.raw_amount = BigInt(1e30);
      }

      wallet_vaults.push(pool);
    }
  }
  return wallet_vaults;
}

//Combine defi vault positions with token wallets into 1 list
function prepWallet(
  global_token_info_debank,
  global_complex_protocol_debank,
  global_balances,
  chain
) {
  //1. Defi vaults
  let wallet_vaults = prepWalletVaults(
    global_complex_protocol_debank,
    global_token_info_debank,
    global_balances,
    chain
  );

  //2. Tokens in wallet
  let wallet_tokens = global_token_info_debank.filter(
    (token) =>
      (token.is_verified || token.protocol_id != "") && token.used == undefined //&& position.is_wallet
  ); //is_verified => Skip spam tokens.
  //token.used=true means token matches an LP token in a vault

  wallet_tokens = wallet_tokens.map((token) => ({
    ...token,
    positionType: "token",
  }));

  // return wallet_vaults;
  if (Utils.isEmpty(wallet_vaults)) {
    return wallet_tokens;
  } else {
    //Vaults first, then tokens
    return [...wallet_vaults, ...wallet_tokens];
  }
}

function bidirectional(tx, wallet, global_transfers) {
  const to_vault = global_transfers.find(
    (xfer) =>
      xfer.transaction_hash == tx.transaction_hash &&
      xfer.from_address == wallet
  );
  const from_vault = global_transfers.find(
    (xfer) =>
      xfer.transaction_hash == tx.transaction_hash && xfer.to_address == wallet
  );
  if (to_vault && from_vault) return true;
  else return false;
}

function add_vault_transfers(
  chain,
  wallet,
  global_transfers,
  global_complex_protocol_debank
) {
  let lp_tokens = [];
  let vaults = [];
  //1. Find LP tokens + vaults in reference farms
  const vaults_in_chain = REF_ASSETS.filter(
    (vault) => vault.chain.toLowerCase() == chainCoins[chain].chainId
  );
  for (const vault of vaults_in_chain) {
    if (vault.key && vault.key.includes(",Farming,")) {
      if (vault.deposit_tokens.length > 1)
        console.log(
          "Warning: vault.deposit_tokens.length>1",
          JSON.stringify(vault)
        );
      let ab;
      if (
        vault.underlying_tokens?.length > 0 &&
        vault.underlying_tokens[0].address.toLowerCase() ==
        vault.deposit_tokens[0].address.toLowerCase()
      )
        continue;
      lp_tokens.push(vault.deposit_tokens[0].address.toLowerCase());
      vaults.push(vault.deposit_address.toLowerCase());
      const a = vault.deposit_address.toLowerCase();
    }
  }
  //2. Add LP tokens in wallet
  const complex = global_complex_protocol_debank.filter(
    (item) => item.chain == chainCoins[chain].chainId
  );
  for (const complex_protocol_item of complex) {
    for (const pool of complex_protocol_item.portfolio_item_list) {
      if (pool.name == "Liquidity Pool") lp_tokens.push(pool.pool_id);
    }
  }
  lp_tokens = [...new Set(lp_tokens)];
  vaults = [...new Set(vaults)];

  const candidate_transfers = global_transfers.filter(
    (xfer) =>
      (vaults.includes(xfer.from_address) ||
        vaults.includes(xfer.to_address) ||
        lp_tokens.includes(xfer.address)) &&
      //Ignore rewards received from vaults
      !(
        xfer.to_address == wallet &&
        reward_tokens[chainCoins[chain].chainId].includes(xfer.address)
      )
  );

  for (tx of candidate_transfers) {
    //Create a vault receipt if ONE of these is true:
    //   a. one-sided transfer / any token / to a known vault OR
    //   b. two-sided transfer / LP token / to a known vault
    //        Example: Sushi farming is two-sided because of a reward token
    //   c. one-sided transfer / LP token / to any address.
    //        Example: Vault is not in JSON, but LP is in wallet, like VISION/ETH
    const isVault =
      vaults.includes(tx.from_address) || vaults.includes(tx.to_address);
    const isLP = lp_tokens.includes(tx.address);
    const one_sided = !bidirectional(tx, wallet, global_transfers);
    if ((one_sided && isVault) || (isLP && isVault) || (one_sided && isLP)) {
      const vault_address =
        tx.to_address == wallet ? tx.from_address : tx.to_address;
      global_transfers.push({
        address: tx.address, //vault_address,
        block_hash: tx.block_hash,
        block_number: tx.block_number,
        block_timestamp: tx.block_timestamp,
        from_address: tx.to_address == wallet ? wallet : vault_address,
        to_address: tx.to_address == wallet ? vault_address : wallet,
        isReceived: !tx.isReceived,
        transaction_hash: tx.transaction_hash,
        value: BigInt(1), //placeholder unit
        type: "vault",
      });
    }
  }
  //After adding some transfers, sort reverse chronologically
  global_transfers = global_transfers.sort(Utils.sortBlockNumber_reverseChrono);
  return global_transfers;
}

async function getWalletCostBasis(
  data,
  global_token_info_debank,
  global_complex_protocol_debank,
  { job, status, part }
) {
  console.log("getWalletCostBasis:", data);
  const chainMoralis = data.chain;
  const chainDebank = chainCoins[data.chain].chainId;
  //const chain_blockheight = await getCurrentBlockNumber(data.chain);
  let sTime = new Date().getTime();
  //Get global data
  const result = await Promise.all([
    getTokenBalances(chainMoralis, data.wallet),
    getTokenTransfers(chainMoralis, data.wallet),
    getTransactions(chainMoralis, data.wallet),
  ]);
  timeCost.getTransData.timeCost += new Date().getTime() - sTime;
  timeCost.getTransData.count += 1;

  let global_balances = result[0];
  let global_transfers = result[1];
  const global_tx = result[2]?.transactions;

  const gb_transfer_tx_ids = [];
  global_transfers.map((transfer) => {
    if (!gb_transfer_tx_ids.includes(transfer.transaction_hash)) {
      gb_transfer_tx_ids.push(transfer.transaction_hash);
    }
  });
  const global_tx_count = result[2]?.txCount;
  const lastTxDate =
    global_transfers[global_transfers.length - 1]?.block_timestamp;
  const transfer_tx_count = gb_transfer_tx_ids.length;

  global_transfers = prepTransfers(
    global_transfers,
    global_tx,
    global_complex_protocol_debank,
    chainMoralis,
    data.wallet
  );

  const global_supply_tokens_debank = getSupplyTokens(
    global_complex_protocol_debank
  );

  //If token specified in request, just do that token instead of the whole wallet
  if (data.token) {
    global_balances = global_balances.filter(
      (each) => each.token_address == data.token
    );
  }

  //Set up for positions loop
  let returnData = [];
  const wallet_positions = prepWallet(
    global_token_info_debank,
    global_complex_protocol_debank,
    global_balances,
    chainDebank
  );

  //Loop through wallet balances, get value + cost basis
  //TODO: Make this loop asynchronous using Promise.all

  for (let i = 0; i < wallet_positions.length; i++) {
    const wallet_position = wallet_positions[i];
    //  if (wallet_position.key == "eth,sushiswap,Farming,0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2|0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") {
    //    console.log("getWalletCostBasis:", wallet_position.id);
    //  } else {
    //    continue;
    //  }
    if (wallet_position.protocol_id && data.jobProtocol && wallet_position.protocol_id != data.jobProtocol) {
      continue;
    }
    let tokenHistory = null;
    sTime = new Date().getTime();
    tokenHistory = await getTokenCostBasis(
      chainMoralis,
      null, //blockheight
      data.wallet,
      wallet_position,
      wallet_position.id, // token address
      BigInt(wallet_position?.raw_amount || 0), //balance
      wallet_position.deposit_address, //for vaults only
      1, // hierarchy_level
      {}, // parent_transaction,
      global_supply_tokens_debank,
      global_transfers,
      global_tx,
      global_token_info_debank
    );
    timeCost.tokenCostBasis.timeCost += new Date().getTime() - sTime;
    timeCost.tokenCostBasis.count += 1;

    //Build main table
    sTime = new Date().getTime();
    let token_result = await makeTokenResult(
      i,
      chainMoralis,
      wallet_position,
      tokenHistory,
      global_token_info_debank,
      global_complex_protocol_debank
    );
    timeCost.makeTokenResult.timeCost += new Date().getTime() - sTime;
    timeCost.makeTokenResult.count += 1;

    returnData.push(token_result);
    if (status) {
      const progress = await job.progress();
      status.current = i + 1;
      status.total = wallet_positions.length;
      status.ready = true;
      progress[part] = status;
      job.progress(progress);
    }
  }

  console.log(timeCost);

  const foornote = [
    {
      chain: chainMoralis,
      totalTxCount: global_tx_count,
      currentTxCount: transfer_tx_count,
      lastTxDate: lastTxDate,
    },
  ];

  let returnResult = {
    footnotes: foornote,
    data: returnData,
  };
  //Sort by value, descending
  return returnResult;
}

async function makeTokenResult(
  i,
  chain,
  wallet_position,
  tokenHistory,
  global_token_info_debank,
  global_complex_protocol_debank
) {
  //console.log("makeTokenResult:", chain);
  // if (chain == "avalanche") {
  //   console.log("breakpt");
  // }
  let token_result = {
    id: "p" + i,
    chain: chain,
    chain_id: 123, //TODO: Chain ID
    chain_logo: debank_chain_details[chain].logo_url,
    type: wallet_position.is_wallet ? "Wallet" : "Yield",
    name: wallet_position?.name,
    type_img: wallet_position.is_wallet
      ? "../assets/images/wallet.jpg"
      : "../assets/images/yield.jpg",
    units: wallet_position.amount,
    value:
      wallet_position.value || wallet_position.amount * wallet_position.price,
    cost_basis: tokenHistory.cost_basis,
    history: tokenHistory.history,
  };

  //If no history, guess cost from value
  if (
    tokenHistory.cost_basis == 0 &&
    tokenHistory.history.length == 0 &&
    token_result.value > 0
  ) {
    token_result.cost_basis = token_result.value;
    token_result.guess_cost_from_vault = true;
  }

  //Protocol column
  let debank_protocol = null;
  if (wallet_position.protocol_id) {
    debank_protocol = debank_protocol_ref.filter(
      (protocol) => protocol.id == wallet_position.protocol_id
    )[0];
    token_result.protocol_id = wallet_position.protocol_id;
    token_result.protocol = debank_protocol?.name || null;
    token_result.protocol_logo = debank_protocol?.logo_url || null;
    token_result.protocol_url = debank_protocol?.site_url || null;
  }

  //Underlying assets column
  //Plan A: Get it from DeBank
  if (wallet_position.detail?.supply_token_list || false) {
    token_result.assets = wallet_position.detail.supply_token_list.map(
      (asset) => ({
        id: asset.id,
        ticker: asset.optimized_symbol,
        logo: asset.logo_url,
      })
    );
    //Plan B: Wallet coin is its own asset
  } else if (wallet_position.is_wallet) {
    token_result.assets = [
      {
        id: wallet_position.id,
        ticker: wallet_position.symbol,
        logo: wallet_position.logo_url || debank_protocol?.logo_url || null,
      },
    ];
    //Plan C: Guess underlying asset from history
  } else {
    //TODO: pass in JSON_CURVE and find the assets from 3CRV to underlying.
    token_result.assets = await getAssets(
      chain,
      tokenHistory.history,
      global_token_info_debank
    ); //Copy liquid assets from tree here
  }

  //If value is blank, fill it in from debank complex protocol api
  if (
    token_result.value == 0 &&
    wallet_position.protocol_id &&
    debank_protocol
  ) {
    if (
      token_result.cost_basis < 0 &&
      isDebtProtocol(wallet_position.protocol_id)
    ) {
      token_result.value = await getDebtValue(
        chain,
        wallet_position,
        token_result.assets,
        global_complex_protocol_debank,
        global_token_info_debank
      );
    } else {
      token_result.value = getDebankValue(
        wallet_position.id,
        debank_protocol,
        token_result.assets,
        global_complex_protocol_debank
      );
    }
  }
  return token_result;
}

function isDebtProtocol(protocol_id) {
  const protocol = debank_protocol_tags.data.find(
    (debank_protocol) => debank_protocol.id == protocol_id
  );
  if (!protocol) return false;
  const isDebt = protocol.tag_ids.includes("debt");
  return isDebt;
}

async function getDebtValue(
  chain,
  wallet_position,
  assets,
  global_complex_protocol_debank,
  global_token_info_debank
) {
  let borrow_token; //so that the variable works outside the try{} block
  const borrowed_asset_id = assets[0].id; //What if >1 asset is borrowed?
  const lending_protocol = global_complex_protocol_debank.filter(
    (protocol) => protocol.id == wallet_position.protocol_id
  );

  //Find coins being borrowed in complex protocol
  try {
    const portfolio_items = lending_protocol.flatMap(
      (protocol) => protocol.portfolio_item_list
    );
    const portfolio_items_borrowing = portfolio_items.filter(
      (item) => item.detail.borrow_token_list
    );
    const borrow_tokens = portfolio_items_borrowing.flatMap(
      (item) => item.detail.borrow_token_list
    );
    borrow_token = borrow_tokens.find((token) => token.id == borrowed_asset_id);
    const amount = borrow_token.amount;
  } catch (error) {
    console.log("getDebtValue: No borrowed tokens found");
    return 0;
  }

  const price = await getTokenPrice(
    chain,
    borrow_token.id,
    null, // _toBlock,
    global_token_info_debank
  );
  const debt_value = borrow_token.amount * price * -1; //negative cost = credit to account
  return debt_value;
}

async function getTokenCostBasis(
  chain,
  block,
  wallet,
  wallet_position,
  token,
  balance,
  deposit_address, //for vaults only
  hierarchy_level,
  parent_transaction,
  global_supply_tokens_debank,
  global_transfers,
  global_tx,
  global_token_info_debank,
  reverse = true
) {

  const blockheight = block?.block_number;
  if (MODE_SETTING === "dev") {
    console.log(
      "CostBasis: (L/token/block/tx/bal)",
      " ".repeat(hierarchy_level),
      hierarchy_level,
      token?.slice(-4) || null,
      blockheight,
      Utils.isEmpty(parent_transaction)
        ? "--"
        : parent_transaction.transaction_hash.slice(-4),
      balance
    );
  }

  //Debug wallet 0x1f14be60172b40dac0ad9cd72f6f0f2c245992e8
  //if (hierarchy_level > 3) return null; //Abort execution.
  // if (hierarchy_level== 4) {
  //   console.log('breakpt');
  // }

  let token_cost = 0,
    current_balance = BigInt(balance),
    token_info = null,
    price = null,
    newHistory = [];
  let sTime;
  //Get token price

  if (!deposit_address && token) {
    sTime = new Date().getTime();
    token_info = await get_debank_token(chain, token, global_token_info_debank);
    timeCost.get_debank_token.timeCost += new Date().getTime() - sTime;
    timeCost.get_debank_token.count += 1;
    token_info.decimals = token_info.decimals || 18;
    if (blockheight) {
      //historical price
      sTime = new Date().getTime();
      price = await getTokenPrice(
        chain,
        token,
        blockheight,
        global_token_info_debank,
        token_info,
        FAST_MODE
      );
      timeCost.ercTokenPrice.timeCost += new Date().getTime() - sTime;
      timeCost.ercTokenPrice.count += 1;
    } else {
      //current price
      price = token_info.price;
    }
  }

  if ((price == null) && token_info?.is_core) {
    const block_date = moment(block?.block_timestamp).format('YYYY-MM-DD');

    price = await getCovalentPrice(
      token_info.optimized_symbol,
      block_date
    );

    console.log(price);
  }

  //Is this one of the underlying tokens?
  const is_supply_token = global_supply_tokens_debank.includes(token);
  const units = Number(balance) / 10 ** (token_info?.decimals || 18);

  //Liquid tokens
  if (
    (Math.abs(units * price) < 1 && price > 0) || //small position
    (hierarchy_level == 1 && token_info && token_info.is_core) || //wallet token
    (hierarchy_level == 2 &&
      price &&
      (token_info.is_core ||
        is_supply_token ||
        token_info.debank_not_found ||
        parent_transaction.type == "borrow")) || //|| parent_transaction.type == "vault")
    (hierarchy_level > 2 && price)
  ) {
    token_cost = units * price;
    if (!Utils.isEmpty(parent_transaction)) {
      //hierarchy_level>1
      newHistory.push({
        units,
        transaction_id: parent_transaction.transaction_hash,
        transaction_url: `${chainCoins[chain].explorer}/${parent_transaction.transaction_hash}`,
        datetime: Utils.convertDateTime(parent_transaction.block_timestamp),
        token_id: token,
        token_name:
          token_info?.name ||
          debank_protocol_ref.filter(
            (protocol) => protocol.id == wallet_position.protocol_id
          )[0]?.name + " vault receipt",
        token_symbol: token_info?.symbol || "<Unknown symbol>",
        token_img: token_info?.logo_url || null,
        fee_native_coin: chainCoins[chain].native_coin,
        cost_basis: token_cost,
        hierarchy_level,
        valued_directly: true,
      });
    }
    return { cost_basis: token_cost, history: newHistory };
  }

  // Non-wallet tokens

  // retrieve list of token transactions to/from wallet, prior to block
  let token_transactions = global_transfers.filter(
    (xfer) =>
      (Utils.isEmpty(parent_transaction) ? true : xfer.isReceived == reverse) && //In L2+, look for only buys or only sells
      xfer.address == token?.toLowerCase() &&
      xfer.used == undefined &&
      xfer.value > 0 &&
      (reverse
        ? Number(xfer.block_number) <= Number(blockheight || 1e20)
        : Number(xfer.block_number) >= Number(blockheight || 1e20))
  );
  if (deposit_address) {
    token_transactions = token_transactions.filter(
      (xfer) =>
        xfer.type == "vault" && //TODO: Check how this works on curve wallets, where we needed vaults.
        (xfer.to_address == deposit_address ||
          xfer.from_address == deposit_address)
    );
  }

  if (!reverse) {
    token_transactions = token_transactions.sort(Utils.sortBlockNumber_Chrono);
  }

  //Debug wallet 0x1f14be60172b40dac0ad9cd72f6f0f2c245992e8
  // if (
  //   wallet_position.id ==
  //     "0x06da0fd433c1a5d7a4faa01111c044910a184553".toLowerCase() &&
  //   hierarchy_level == 1
  // ) {
  // token_transactions = token_transactions.slice(0, 5); //Faster debugging: Limit to 5 tx per position
  // }

  let nativePrice;
  if (FAST_MODE == true && token_transactions.length > 0) {
    sTime = new Date().getTime();
    nativePrice = await getTokenPrice(
      chain,
      chainCoins[chain].address,
      null,
      global_token_info_debank,
      FAST_MODE
    );
    timeCost.nativeCoinPrice.timeCost += new Date().getTime() - sTime;
    timeCost.nativeCoinPrice.count += 1;
  }
  // For each transaction
  for (let i = 0; i < token_transactions.length; i++) {
    const transaction = token_transactions[i];

    if (transaction.used) continue; //transaction might be marked used in recursive calls
    else transaction.used = true;

    let transaction_cost = 0,
      used_pct = 1;

    const transaction_detail =
      global_tx.filter((tx) => tx.hash === transaction.transaction_hash)[0] ||
      {};

    //calculate the balance of token in wallet, just before transaction.
    const isReceived = transaction.isReceived;
    const units_received = transaction.value * (isReceived ? 1n : -1n);
    if (isReceived && current_balance < transaction.value) {
      used_pct = Number(current_balance) / Number(transaction.value);
      current_balance = 0;
    } else {
      used_pct = 1;
      current_balance = current_balance - units_received;
    }

    // calculate the cost basis of current transaction, starting w/offseting coins
    let offsetting_coins = global_transfers.filter(
      (xfer) =>
        xfer.transaction_hash == transaction.transaction_hash &&
        xfer.used == undefined &&
        (transaction.type == "borrow" ? true : xfer.isReceived != isReceived)
      //For normal transactions, offsetting transfers is in opposite direction (!isReceive)
      //For borrow transactions, it's in the same direction
    );

    //If coin was sent, sort chronological to look for future dispositions
    if (!isReceived && offsetting_coins.length > 1) {
      offsetting_coins = offsetting_coins.sort(Utils.sortBlockNumber_Chrono);
    }

    let childHistory = [];

    for (let j = 0; j < offsetting_coins.length; j++) {
      const offsetting_coin = offsetting_coins[j];
      offsetting_coin.used = true;
      let offsetting_coin_units =
        offsetting_coin.value *
        (isReceived ? 1n : -1n) *
        (transaction.type == "borrow" ? -1n : 1n);
      //  For borrow transactions: debt and borrowed token move in same direction
      if (used_pct < 1) {
        offsetting_coin_units = Number(offsetting_coin_units) * used_pct;
        offsetting_coin_units = BigInt(Math.round(offsetting_coin_units));
      }
      let offsetting_deposit_address = null;
      if (offsetting_coin.type == "vault") {
        offsetting_deposit_address =
          offsetting_coin.to_address == wallet
            ? offsetting_coin.from_address
            : offsetting_coin.to_address;
      }

      const CostBasisResult = await getTokenCostBasis(
        chain,
        offsetting_coin,
        wallet,
        wallet_position,
        offsetting_coin.address,
        offsetting_coin_units, //balances
        offsetting_deposit_address, //deposit_address, for vaults only
        hierarchy_level + 1,
        transaction, // parent transaction (transfer)
        global_supply_tokens_debank,
        global_transfers,
        global_tx,
        global_token_info_debank,
        isReceived
      );
      transaction_cost = transaction_cost + CostBasisResult.cost_basis;

      childHistory = childHistory.concat(CostBasisResult.history);
    }

    token_cost = token_cost + transaction_cost;

    let native_price;
    if (FAST_MODE) {
      native_price = nativePrice;
    } else {
      sTime = new Date().getTime();
      native_price = await getTokenPrice(
        chain,
        chainCoins[chain].address,
        blockheight,
        global_token_info_debank
      );
      timeCost.nativeCoinPrice.timeCost += new Date().getTime() - sTime;
      timeCost.nativeCoinPrice.count += 1;
    }
    sTime = new Date().getTime();

    const native_token_info = await get_debank_token(
      chain,
      chainCoins[chain].address,
      global_token_info_debank
    );
    timeCost.get_debank_token.timeCost += new Date().getTime() - sTime;
    timeCost.get_debank_token.count += 1;
    const fee_native_units =
      (transaction_detail.gas * transaction_detail.gas_price) /
      10 ** (native_token_info?.decimals || 18);
    let units = Number(units_received) / 10 ** (token_info?.decimals || 18);
    if (used_pct < 1) {
      units = Number(units) * used_pct;
      units = Math.round(units);
    }

    newHistory.push({
      units: units,
      transaction_id: transaction.transaction_hash,
      transaction_url: `${chainCoins[chain].explorer}/${transaction.transaction_hash}`,
      datetime: Utils.convertDateTime(transaction.block_timestamp),
      token_id: token,
      token_name:
        token_info?.name ||
        debank_protocol_ref.filter(
          (protocol) => protocol.id == wallet_position.protocol_id
        )[0]?.name + " vault receipt",
      token_symbol: token_info?.symbol,
      token_img:
        token_info?.logo_url ||
        debank_protocol_ref.filter(
          (p) => p.id == token_info?.protocol_id || 0
        )[0]?.logo_url ||
        null,
      fee_native_coin: chainCoins[chain].native_coin,
      fee_native_units: fee_native_units,
      fee_usd: fee_native_units * native_price || 0,
      cost_basis: transaction_cost,
      used_pct: used_pct,
      hierarchy_level: hierarchy_level,
      valued_directly: false,
      child: childHistory,
    });

    if (current_balance <= 0) break;
  } //end token transaction loop

  return { cost_basis: token_cost, history: newHistory };
}

//Log eth withdrawals from AAVE: aWETH outbound, ETH inbound
function inbound_native_transfers(transfers, chain, wallet) {
  if (chain != "eth") return transfers;
  const AWETH_ADDRESS = "0x030ba81f1c18d280636f32af80b9aad02cf0854e";
  // const AAWE_WETH_GETEWAY = "0xcc9a0b7c43dc2a5f023bb9b738e45b0ef6b06e04";

  const aave_eth_withdrawals = transfers.filter(
    (xfer) => xfer.address == AWETH_ADDRESS && xfer.from_address == wallet
  );
  for (let i = 0; i < aave_eth_withdrawals.length; i++) {
    const xfer = aave_eth_withdrawals[i];
    transfers.push({
      address: chainCoins[chain].address, //WETH transfer
      block_hash: xfer.block_hash,
      block_number: xfer.block_number,
      block_timestamp: xfer.block_timestamp,
      from_address: xfer.to_address, //from AAVE ETH Router
      to_address: wallet, //to wallet
      transaction_hash: xfer.transaction_hash,
      value: xfer.value,
    });
  }

  return transfers;
}

module.exports = {
  getWalletsCostHistory,
};
