import fs from "fs";
import got from "got";

const stackingAddress = "0xfd31c7d00ca47653c6ce64af53c1571f9c36566a";
let page = 0;

async function fetch() {
  const sOHMRebases = [];
  while (true) {
    const { body } = await got("https://api.thegraph.com/subgraphs/name/drondin/olympus-graph", {
      method: "POST",
      body: JSON.stringify({
        variables: {},
        query: `{
        rebases(first: 100, skip: ${page * 100}, orderBy: timestamp) {
          timestamp
          percentage
          contract
        }
      }`,
      }),
    });
    const { rebases } = JSON.parse(body).data;
    if (rebases.length == 0) break;
    sOHMRebases.push(
      ...rebases
        .filter(({ contract }) => contract == stackingAddress)
        .map(({ timestamp, percentage }) => ({ timestamp, percentage }))
    );
    page += 1;
  }
  fs.writeFileSync("./rebases.json", JSON.stringify(sOHMRebases, null, 2));
}

fetch();
