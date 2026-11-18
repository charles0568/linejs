import { assert, test } from "vite-plus/test";
import { BaseClient } from "../core/mod.ts";
import { isLegyGatewayRejection } from "./mod.ts";

// A V3-looking token, so "auto" routes /S4 through the encrypted gateway.
const FAKE_V3_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";

// Compact-protocol reply for getProfile whose success field is an empty struct.
function emptyReply(method: string): Uint8Array<ArrayBuffer> {
	const name = new TextEncoder().encode(method);
	return new Uint8Array([0x82, 0x41, 0x00, name.length, ...name, 0x0c, 0x00, 0x00, 0x00]);
}

function gatewayRejection(): Response {
	return new Response(null, {
		status: 404,
		headers: { server: "legy", "content-length": "0" },
	});
}

function clientWith(
	encrypted: boolean | "auto",
	onEnc: () => Response,
): { client: BaseClient; urls: string[] } {
	const urls: string[] = [];
	const client = new BaseClient({
		device: "DESKTOPWIN",
		legy: { encrypted },
		fetch: (info) => {
			const url = new Request(info).url;
			urls.push(new URL(url).pathname);
			if (url.endsWith("/enc")) return Promise.resolve(onEnc());
			return Promise.resolve(new Response(emptyReply("getProfile")));
		},
	});
	client.authToken = FAKE_V3_TOKEN;
	return { client, urls };
}

test("empty legy 404 is recognised as a gateway rejection", async () => {
	assert.deepEqual(await isLegyGatewayRejection(gatewayRejection()), true);
	assert.deepEqual(
		await isLegyGatewayRejection(new Response("x", { status: 404, headers: { server: "legy" } })),
		false,
	);
	assert.deepEqual(
		await isLegyGatewayRejection(new Response(null, { status: 404, headers: { server: "nginx" } })),
		false,
	);
	assert.deepEqual(await isLegyGatewayRejection(new Response(null, { status: 200 })), false);
});

// #280: since 2026-11-18 /enc answers every request with an empty 404 while
// the plain path works. "auto" should keep the client usable instead of
// surfacing a Thrift parse failure.
test("auto mode falls back to the plain path when /enc rejects", async () => {
	const { client, urls } = clientWith("auto", gatewayRejection);
	await client.request.request([], "getProfile", 4, false, "/S4");
	assert.deepEqual(urls, ["/enc", "/S4"]);

	// The rejection is remembered, so the next call goes straight to plain.
	await client.request.request([], "getProfile", 4, false, "/S4");
	assert.deepEqual(urls, ["/enc", "/S4", "/S4"]);
});

test("encrypted: true does not fall back", async () => {
	const { client, urls } = clientWith(true, gatewayRejection);
	let failed = false;
	try {
		await client.request.request([], "getProfile", 4, false, "/S4");
	} catch {
		failed = true;
	}
	assert.deepEqual(failed, true);
	assert.deepEqual(urls, ["/enc"]);
});
