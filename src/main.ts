import { createServer } from "./server/websocket-server.js";

const DEFAULT_PORT: number = 8080;
const portText: string = process.env.PORT ?? String(DEFAULT_PORT);
const port: number = Number.parseInt(portText, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	throw new Error(`Invalid PORT: ${portText}`);
}

createServer(port);
