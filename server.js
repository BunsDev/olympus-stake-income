import { readFile } from "fs";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const server = createServer(function (_req, res) {
  readFile(new URL("./index.html", import.meta.url), { encoding: "utf-8" }, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end(JSON.stringify(err));
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });
let data = {};

wss.on("connection", (ws) => {
  if (data) ws.send(JSON.stringify(data));
});
export function broadcastData(update) {
  Object.keys(update).forEach((key) => (data[key] = Number(update[key].toString())));
  wss.clients.forEach((ws) => ws.send(JSON.stringify(data)));
}

server.listen(8000);
