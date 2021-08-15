import fs from "fs";
import got from "got";
import chalk from "chalk";
import { ethers } from "ethers";
import dotenv from "dotenv";
import Big from "big.js";

import { broadcastData } from "./server.js";

import stackingABI from "./stackingABI.js";
import sOHMABI from "./sOHMABI.js";

const { parsed } = dotenv.config();

const wallet = parsed.WALLET;

const provider = parsed.RPC_URL
  ? new ethers.providers.JsonRpcProvider(parsed.RPC_URL)
  : new ethers.providers.EtherscanProvider(null, parsed.ETHERSCAN_APIKEY);
const stackingAddress = "0xfd31c7d00ca47653c6ce64af53c1571f9c36566a";
const sOHMAddress = "0x04f2694c8fcee23e8fd0dfea1d4f5bb8c352111f";
const OHMAddress = "0x383518188c0c6d7730d91b2c03a03c837814a899";
const stackingContract = new ethers.Contract(stackingAddress, stackingABI, provider);
const sOHMContract = new ethers.Contract(sOHMAddress, sOHMABI, provider);

const rebases = JSON.parse(fs.readFileSync("./rebases.json", { encoding: "utf-8" }));

let timestamp = Date.now();
let ohmPrice = 0;
let balance = 0;
let delta = 0;
let spent = 0;
let ohmPurchased = 0;
let historicBalance = [];
let usd2rub = 1;

function updateSpending(balance, prevBalance, rebaseIndex) {
  let { sohmBalance } = prevBalance;
  sohmBalance = Big(sohmBalance);

  for (
    let rebase = rebases[rebaseIndex];
    rebase && Number(rebase.timestamp) < Number(balance.timestamp);
    rebase = rebases[(rebaseIndex += 1)]
  ) {
    sohmBalance = sohmBalance.times(Big(rebase.percentage).plus(1.000043199136)); // NOTE: Use magic constant, because calculation ohmPurchased from rebases is inaccurate
  }

  const sohmDelta = Big(balance.sohmBalance).minus(sohmBalance);
  const price = Big(balance.dollarBalance).div(balance.sohmBalance);

  // TODO unstake?
  ohmPurchased = ohmPurchased.plus(sohmDelta);
  spent = spent.plus(sohmDelta.times(price));

  return rebaseIndex;
}

async function calculateSpending() {
  const { body } = await got("https://api.thegraph.com/subgraphs/name/drondin/olympus-graph", {
    method: "POST",
    body: JSON.stringify({
      variables: {},
      query: `{
        ohmie(id: "${wallet}") {
          historicBalance(orderBy: timestamp) {
            timestamp
            sohmBalance
            dollarBalance
          }
        }
      }`,
    }),
  });
  ({
    ohmie: { historicBalance },
  } = JSON.parse(body).data);

  const [initialBalance, ...balances] = historicBalance;

  spent = Big(initialBalance.dollarBalance);
  ohmPurchased = Big(initialBalance.sohmBalance);
  let prevBalance = initialBalance;
  let rebaseIndex = rebases.findIndex((rebase) => Number(rebase.timestamp) > Number(prevBalance.timestamp));

  balances.forEach((balance) => {
    rebaseIndex = updateSpending(balance, prevBalance, rebaseIndex);

    prevBalance = balance;
  });
}

async function updateOHMs() {
  const { body } = await got("https://api.thegraph.com/subgraphs/name/drondin/olympus-graph", {
    method: "POST",
    body: JSON.stringify({
      variables: {},
      query: `{
        ohmie(id: "${wallet}") {
          historicBalance(first: 1, orderBy: timestamp, orderDirection: desc) {
            timestamp
            sohmBalance
            dollarBalance
          }
        }
        rebases(first: 1, orderBy: timestamp, orderDirection: desc) {
          contract
          timestamp
          percentage
        }
        protocolMetrics(first: 1, orderBy: timestamp, orderDirection: desc) {
          ohmPrice
        }
      }`,
    }),
  });
  const {
    protocolMetrics,
    ohmie,
    rebases: [lastRebase],
  } = JSON.parse(body).data;
  ({ timestamp } = lastRebase);
  [{ ohmPrice }] = protocolMetrics;
  ohmPrice = Big(ohmPrice);

  processBalance(ohmie.historicBalance);

  if (rebases.slice(-1)[0].timestamp != timestamp && lastRebase.contract == stackingAddress) {
    rebases.push({ timestamp: lastRebase.timestamp, percentage: lastRebase.percentage });
    fs.writeFileSync("./rebases.json", JSON.stringify(rebases, null, 2));
  }
}

async function updateBalance() {
  const supply = await sOHMContract.circulatingSupply();
  const { distribute } = await stackingContract.epoch();
  balance = Big(await sOHMContract.balanceOf(wallet)).div(10 ** 9);
  delta = Big(distribute).div(supply).div(8).div(60).div(60).div(10).times(balance);
}

async function updateUSDRates() {
  const { body } = await got("https://api.exchangerate.host/latest?base=USD&symbols=RUB");
  usd2rub = Big(JSON.parse(body).rates.RUB);
}

async function processBalance([balance]) {
  let prevBalance = historicBalance.slice(-1)[0];

  if (balance.timestamp == prevBalance.timestamp) return;

  let rebaseIndex = rebases.findIndex((rebase) => Number(rebase.timestamp) > Number(prevBalance.timestamp));

  updateSpending(balance, prevBalance, rebaseIndex);

  historicBalance.push(balance);
}

calculateSpending()
  .then(() => Promise.all([updateBalance(), updateOHMs(), updateUSDRates()]))
  .then(() => {
    broadcastData({ delta, timestamp, balance, ohmPrice, usd2rub, spent });
    const updateInt = setInterval(
      () =>
        Promise.all([updateBalance(), updateOHMs()]).then(() =>
          broadcastData({ delta, timestamp, balance, ohmPrice, usd2rub, spent })
        ),
      60 * 1000
    );
    const getRates = setInterval(updateUSDRates, 60 * 60 * 1000);
    const showProfitInt = setInterval(() => {
      const reward = delta.times(Math.min(8 * 60 * 60 * 1000, Date.now() - timestamp * 1000)) / 100;
      const newBalance = balance.plus(reward);
      const avgPrice = spent.div(ohmPurchased);
      const newAvgPrice = spent.div(newBalance);
      const dBalance = newBalance.minus(ohmPurchased);
      const profit = ohmPrice.minus(newAvgPrice);
      console.log(
        [
          "----------------------".repeat(1),
          profit.gt(0) ? chalk.green(`$+${profit.toFixed(5)}`) : chalk.red(`$${profit.toFixed(5)}`),
          `$ ${avgPrice.toFixed(5)}`,
          `$ ${newAvgPrice.toFixed(5)}`,
          `$ ${ohmPrice.toFixed(5)}`,
          chalk.green(`Ω+${dBalance.toFixed(9)}`),
          `Ω ${newBalance.toFixed(9)}`,
        ].join("\n")
      );
    }, 100);
  });
