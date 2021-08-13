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
let data = null;

wss.on("connection", (ws) => {
  if (data) ws.send(JSON.stringify(data));
});
export function broadcastData(update) {
  data = update;
  wss.clients.forEach((ws) => ws.send(JSON.stringify(update)));
}

server.listen(8000);
