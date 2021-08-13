import fs from "fs";
import got from "got";
import chalk from "chalk";
import { ethers } from "ethers";
import dotenv from "dotenv";

import { broadcastData } from "./server.js";

import stackingABI from "./stackingABI.js";
import sOHMABI from "./sOHMABI.js";

const { parsed } = dotenv.config();

const wallet = parsed.WALLET;

// const provider = new ethers.providers.JsonRpcProvider("http://194.163.161.9:8545");
const etherscan = new ethers.providers.EtherscanProvider(null, parsed.ETHERSCAN_APIKEY);
const stackingAddress = "0xfd31c7d00ca47653c6ce64af53c1571f9c36566a";
const sOHMAddress = "0x04f2694c8fcee23e8fd0dfea1d4f5bb8c352111f";
const OHMAddress = "0x383518188c0c6d7730d91b2c03a03c837814a899";
const stackingContract = new ethers.Contract(stackingAddress, stackingABI, etherscan);
const sOHMContract = new ethers.Contract(sOHMAddress, sOHMABI, etherscan);

let lastRebaseIndex = Number(fs.readFileSync("./lastRebase", { encoding: "utf-8" }));
let [lastBuyBlock, lastBuyTimestamp] = fs
  .readFileSync("./lastOHMBuyBlock", { encoding: "utf-8" })
  .split("\n")
  .filter(Boolean)
  .map((v) => Number(v));

async function getLastRebase() {
  let index = lastRebaseIndex;
  let rebase;
  while (true) {
    try {
      rebase = await sOHMContract.rebases(index);
      index += 1;
    } catch (_) {
      lastRebaseIndex = index - 1;
      fs.writeFileSync("./lastRebase", String(lastRebaseIndex));
      return rebase;
    }
  }
}

// TODO Save contract/API rebases somewhere
// TODO Check the latest rebase each minute
// TODO Get rebases from the api and join them by amount and amountRebased
// TODO Use percentage to calculate spent amount
// TODO Where is no need to call etherscan

const normalizedOHMs = 8; // TODO increase for each purchase
let timestamp = Date.now();
let ohmPrice = 0;
let balance = 0;
let delta = 0;
let spent = Number(parsed.SPENT); // TODO automate
let ohmPurchased = Number(parsed.OHM_PURCHASED);
let usd2rub = 1;

async function updateOHMs() {
  const { body } = await got("https://api.thegraph.com/subgraphs/name/drondin/olympus-graph", {
    method: "POST",
    body: JSON.stringify({
      variables: {},
      query: `{
        ohmie(id: "${wallet}") {
          historicBalance {
            timestamp
            sohmBalance
            dollarBalance
          }
        }
        rebases(first: 5, orderBy: timestamp, orderDirection: desc) {
          amount
          timestamp
          percentage
        }
        protocolMetrics(first: 1, orderBy: timestamp, orderDirection: desc) {
          ohmPrice
        }
      }`,
    }),
  });
  const { protocolMetrics, ohmie } = JSON.parse(body).data;
  [{ ohmPrice }] = protocolMetrics;
  ohmPrice = Number(ohmPrice);
  const supply = await sOHMContract.circulatingSupply();
  const { distribute } = await stackingContract.epoch();
  const rebase = await getLastRebase();
  ({ timestamp } = await etherscan.getBlock(Number(rebase.blockNumberOccured)));
  balance = (await sOHMContract.balanceOf(wallet)) / 10 ** 9;
  delta = (distribute / supply / 8 / 60 / 60 / 10) * balance;
  spent = await updateSpending(ohmie.historicBalance);
}

async function updateUSDRates() {
  const { body } = await got("https://api.exchangerate.host/latest?base=USD&symbols=RUB");
  usd2rub = Number(JSON.parse(body).rates.RUB);
}

// TODO Use different way to calculate spending
// TODO take history balance
// TODO for each entity take amount and timestamp
// TODO apply rebases percentage cumulatively until the next balance entity, repeat
// TODO substract result for each step from the next balance entity
// TODO you will get exact purchased amount
// TODO apply average price
async function updateSpending(historicBalance) {
  // TODO Find log with ohm address
  /*
      {
      transactionIndex: 127,
      blockNumber: 12963968,
      transactionHash: '0x8e72ac4136b5ae2cbe24e898404281327e36f8fbc788dff7bd7187f11a58dcbd',
      address: '0x383518188C0C6d7730D91b2c03a03C837814a899',
      topics: [Array],
      data: '0x0000000000000000000000000000000000000000000000000000000105d79ce4',
      logIndex: 254,
      blockHash: '0x2c266dfe675290c5b902136764afeb11a1aa7c7176f7554c85dbc54c8c33106e'
    },
  */
  // TODO Try to use AbiCoder to decode
  if ((() => false)()) {
    const txs = await etherscan.getHistory(wallet, 12963968, 12963968);
    const a = await Promise.all(txs.map((tx) => etherscan.getTransactionReceipt(tx.hash).then((t) => t.logs)));
    console.log(txs, a);
    // TODO sOHMbalance / USDBalance = price => price * txAmount = spent => spent to overall spent
  }
  // TODO Find the way to figure out how to know amount and token data from tx
  // TODO check timestamp with last buy block
  // TODO if timestamp greater, update buy blocks and update spending value
  // TODO also save buy block
  // const txs = await etherscan.getHistory(wallet);
  // console.log(txs);
  // spent = 0; // TODO
  return spent;
}

Promise.all([updateOHMs(), updateUSDRates()]).then(() =>
  broadcastData({ delta, timestamp, balance, ohmPrice, usd2rub, spent })
);

const updateInt = setInterval(async () => {
  await updateOHMs();
  broadcastData({ delta, timestamp, balance, ohmPrice, usd2rub, spent });
}, 60 * 1000);
const getRates = setInterval(updateUSDRates, 60 * 60 * 1000);
const showProfitInt = setInterval(() => {
  const reward = (delta * Math.min(8 * 60 * 60 * 1000, Date.now() - timestamp * 1000)) / 100;
  const newBalance = balance + reward;
  const avgPrice = spent / ohmPurchased;
  const newAvgPrice = spent / newBalance;
  const dBalance = newBalance - ohmPurchased;
  const profit = Number((ohmPrice - newAvgPrice).toFixed(5));
  console.log(
    [
      "----------------------".repeat(1),
      profit > 0 ? chalk.green(`$+${profit}`) : chalk.red(`$${profit}`),
      `$ ${avgPrice.toFixed(5)}`,
      `$ ${newAvgPrice.toFixed(5)}`,
      `$ ${ohmPrice.toFixed(5)}`,
      chalk.green(`Ω+${dBalance.toFixed(9)}`),
      `Ω ${newBalance.toFixed(9)}`,
    ].join("\n")
  );
}, 100);

// TODO Get transactions from ethereum for OHMs
//

// TODO Save last transaction block
// TODO Save txs history
// TODO subscriber on txs?
