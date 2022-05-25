const axios = require("axios");
const Moralis = require("moralis/node");
const reward_tokens = require("../data/debank/rewards.json");
const { chainCoins } = require("../constant");

//Matches keys generated by debank_protocols/src/2a_analyze_debank.js
const poolKey = (protocol, pool) => {
  const supply_tokens = pool.detail.supply_token_list.map((token) => token.id);
  const supply_tokens_hash = supply_tokens.sort().join("|");
  const pool_key = [
    protocol.chain,
    protocol.id,
    pool.name,
    pool?.pool_id || null,
    supply_tokens_hash,
  ].join(",");
  return pool_key;
};

async function get_debank_token(chain, token, token_info_cache) {
  //Plan A: Get token metadata from cache
  let result = token_info_cache.filter((tk) => tk.id === token)[0];
  if (typeof result != "undefined" && detectCorrectResult(result)) {
    return result;
  }
  try {
    //Plan B: Get it from debank api
    let result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url: `https://openapi.debank.com/v1/token?chain_id=${chainCoins[chain].chainId}&id=${token}`,
    });
    result = result.data;

    // Plan C: Get it from Moralis
    if (!detectCorrectResult(result)) {
      result = await Moralis.Web3API.token.getTokenMetadata({
        chain: chain,
        addresses: [token],
      });
      result = result[0];

      //Format Moralis API response the same as DeBank's
      result = {
        id: result.address,
        chain: chain,
        decimals: result.decimals,
        is_core: false,
        logo_url: result.logo,
        name: result.name,
        symbol: result.name,
        optimized_symbol: result.name,
        is_verified: result.validated == 1,
        debank_not_found: true, //Used later to treat the coin as liquid in next loop
      };
    }
    // console.log('result ->', result)
    result.currently_in_wallet = false; //add it to the reference but don't loop through it
    token_info_cache.push(result);
    return result;
  } catch (err) {
    console.log(
      "get_debank_token error: chain=" + chain,
      "token=" + token,
      "error=" + JSON.stringify(err)
    );
    return null;
  }
}

async function getDeBankComplexProtocol(_address) {
  try {
    const result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url: `https://openapi.debank.com/v1/user/complex_protocol_list?id=${_address}`,
    });
    return result.data;
  } catch (err) {
    console.log("get complex protocol", err);
    return null;
  }
}

function getSupplyTokens(_complex_protocol_debank) {
  //const chainID = chainCoins[chain].chainId;
  const pools = _complex_protocol_debank.flatMap(
    (protocol) => protocol.portfolio_item_list
  );
  const supply_tokens = pools.flatMap((pool) => pool.detail.supply_token_list);
  const supply_no_nulls = supply_tokens.filter((token) => token?.id);
  const supply_ids = supply_no_nulls.flatMap((token) => token?.id);
  const supply_unique = [...new Set(supply_ids)];
  return supply_unique;
}

async function getTokenInfoByDebank(_address) {
  try {
    const url = `https://openapi.debank.com/v1/user/token_list?&id=${_address}&is_all=true`;
    const result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url,
    });
    return result.data;
  } catch (err) {
    console.log("get token price", err);
    return null;
  }
}

async function getTokenHistoryDebank(_address, token_id, chain_id, start_time) {
  try {
    const url = `https://api.debank.com/history/list?chain=${chain_id}&page_count=1&start_time=${start_time}&token_id=${token_id}&user_addr=${_address}`;
    const result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url,
    });
    return result.data;
  } catch (err) {
    console.log("get token price", err);
    return null;
  }
}

function detectCorrectResult(result) {
  if (!result) {
    return false;
  }

  var regex = /^[A-Za-z0-9\s()]*$/;
  if (!regex.test(result.name)) {
    return false;
  }

  return true;
}

module.exports = {
  getTokenInfoByDebank,
  getSupplyTokens,
  getDeBankComplexProtocol,
  get_debank_token,
  getTokenHistoryDebank,
  poolKey,
  reward_tokens,
};