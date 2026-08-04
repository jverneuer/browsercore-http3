import { FakeQuic, driveFakeServer } from "./fake-quic.ts";
import { connectHttp3 } from "../src/connection.ts";

const quic = new FakeQuic();
console.log("starting server");
driveFakeServer(quic.server).then(() => console.log("server done"));
console.log("starting client");
try {
    const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 2000 });
    console.log("HANDSHAKE OK");
} catch (e) {
    console.log("HANDSHAKE ERROR:", e.message);
}
process.exit(0);
