const Moralis = require("moralis/node");
const config = require("./../config");
const axios = require("axios");
const MORALLIS_SETTINGS = config.CONFIG.moralis;

Moralis.start(MORALLIS_SETTINGS).then(async () => {
  console.log("moralis successfully started");
  //const block = await Moralis.Plugins.covalent.getChains();
  const xfers = await Moralis.Plugins.covalent.getErc20TokenTransfersForAddress(
    {
      chainId: 137,
      address: "0x22da1eedebc60c1b8c3a0c48f5c81bbe2b943dd9",
      tokenAddress: "0xdaB35042e63E93Cc8556c9bAE482E5415B5Ac4B1",
      //startingBlock: "19753318",
      endBlock: "19753318",
      //pageSize: 1,
    }
  );
  const covalent_key = "ckey_346ff91e4fe34100ab0c6795071";
  const chainNumber = 137;
  const wallet = "0x22da1eedebc60c1b8c3a0c48f5c81bbe2b943dd9";
  const token = "0x7a4b1abc1409c69c2ed71ab34dae43e2ff6f9928";
  const block = "33014112";
  const URL = `https://api.covalenthq.com/v1/${chainNumber}/address/${wallet}/transfers_v2/?quote-currency=USD&format=JSON&contract-address=${token}&starting-block=${block}&ending-block=${block}&key=${covalent_key}`;
  let result = await axios({
    method: "get",
    header: { "content-type": "application/json" },
    url: URL,
  });
  const result_block = result.data.data.items.find(
    (x) => x.block_height == block
  );
  const result_token = result_block.transfers.find(
    (x) => x.contract_address == token.toLowerCase()
  );
  const result_price = result_token.quote_rate;
  //return result_price
  console.log(result);
  //
});
