import WebSocket from "ws";

const url: string = process.env.WS_URL ?? "ws://localhost:8080";
const socket: WebSocket = new WebSocket(url);

socket.on("open", (): void => {
	socket.send(JSON.stringify({
		type: "request",
		id: "test-1",
		method: "ping",
		params: {}
	}));
});

socket.on("message", (data: WebSocket.RawData, isBinary: boolean): void => {
	const text: string = isBinary ? data.toString("base64") : data.toString("utf8");
	console.log(text);
	socket.close();
});

socket.on("error", (error: Error): void => {
	console.error("WebSocket client error:", error);
	process.exitCode = 1;
});
