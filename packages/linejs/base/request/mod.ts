import { type NestedArray, type ParsedThrift, type ProtocolKey, Protocols } from "../thrift/mod.ts";
import { type BaseClient, InternalError } from "../core/mod.ts";
import { shouldUseLegyEncryptedAccess } from "./auth_token.ts";
import { LegyEncryptedTransport } from "./legy.ts";

const square = ["/SQ1", "/SQLV1"];

/**
 * Request Client
 */
/**
 * @class RequestClient
 * @description A client for making requests to the LINE API.
 *
 * @property {BaseClient} client - The base client instance.
 * @property {string} endpoint - The endpoint for the API requests.
 * @property {string} userAgent - The user agent string for the requests.
 * @property {string} systemType - The system type string for the requests.
 * @property {Record<string, string | undefined>} EXCEPTION_TYPES - A static record of exception types based on request paths.
 *
 * @constructor
 * @param {BaseClient} client - The base client instance.
 */
export class RequestClient {
	readonly client: BaseClient;
	endpoint: string;
	userAgent: string;
	#legyTransport?: LegyEncryptedTransport;
	/**
	 * In "auto" mode, the time until which the encrypted gateway is skipped
	 * after it rejected a request (see {@link isLegyGatewayRejection}).
	 */
	#legyRejectedUntil = 0;
	/**
	 * x-line-application
	 */
	systemType: string;
	static readonly EXCEPTION_TYPES: Record<string, string | undefined> = {
		"/S3": "TalkException",
		"/S4": "TalkException",
		"/SYNC4": "TalkException",
		"/SYNC3": "TalkException",
		"/CH3": "ChannelException",
		"/CH4": "ChannelException",
		"/SQ1": "SquareException",
		"/LIFF1": "LiffException",
		"/api/v3p/rs": "TalkException",
		"/api/v4p/rs": "TalkException",
		"/api/v3/TalkService.do": "TalkException",
	};

	constructor(client: BaseClient) {
		const deviceDetails = client.deviceDetails;
		this.endpoint = client.endpoint ?? "legy.line-apps.com";
		this.systemType = `${deviceDetails.device}\t${deviceDetails.appVersion}\t${deviceDetails.systemName}\t${deviceDetails.systemVersion}`;
		this.userAgent = `Line/${deviceDetails.appVersion}`;
		this.client = client;
	}

	/**
	 * @description Request to LINE API.
	 *
	 * @param value - The thrift value(argument) to request.
	 * @param methodName - The method name of the request.
	 * @param protocolType - The protocol type of the request.
	 * @param parse - Whether to parse the response.
	 * @param path - The path of the request.
	 * @param headers - The headers of the request.
	 * @param timeout - The timeout milliseconds of the request.
	 * @returns The response.
	 */
	public async request<T = unknown>(
		value: NestedArray,
		methodName: string,
		protocolType: ProtocolKey = 3,
		parse: boolean | string = true,
		path: string = "/S3",
		headers: Record<string, string | undefined> = {},
		timeout = this.client.config.timeout,
	): Promise<T> {
		if (this.client?.disabled) {
			throw new InternalError(
				"ClientClosed",
				"Request aborted: client has been disabled (logged out)",
			);
		}
		const res = await this.requestCore(
			path,
			value,
			methodName,
			protocolType,
			headers,
			undefined,
			parse,
			undefined,
			timeout,
		);
		return res.data.success;
	}

	/**
	 * @description Request to LINE API by raw.
	 *
	 * @param {string} [path] - The path of the request.
	 * @param {NestedArray} [value] - The value to request.
	 * @param {string} [methodName] - The method name of the request.
	 * @param {ProtocolKey} [protocolType] - The protocol type of the request.
	 * @param {object} [appendHeaders={}] - The headers to append to the request.
	 * @param {string} [overrideMethod="POST"] - The method of the request.
	 * @param {boolean | string} [parse=true] - Whether to parse the response.
	 * @param {boolean} [isReRequest=false] - Is Re-Request.
	 * @param {number} [timeout=this.timeOutMs] - The timeout milliseconds of the request.
	 * @returns {Promise<ParsedThrift>} The response.
	 * @throws {InternalError} If the request fails or timeout.
	 */
	private async requestCore(
		path: string,
		value: NestedArray,
		methodName: string,
		protocolType: ProtocolKey,
		appendHeaders: object = {},
		overrideMethod: string = "POST",
		parse: boolean | string = true,
		isReRequest: boolean = false,
		timeout: number = this.client.config.timeout,
	): Promise<ParsedThrift> {
		const protocol = Protocols[protocolType];

		const headers = {
			...this.getHeader(overrideMethod),
			...appendHeaders,
		};

		this.client.log("writeThrift", {
			value,
			methodName,
			protocolType,
		});

		const Trequest = this.client.thrift.writeThrift(value, methodName, protocol);

		this.client.log("request", {
			methodName,
			path: `https://${this.endpoint}${path}`,
			method: overrideMethod,
			headers,
			timeout,
			body: Trequest,
		});

		const request = new Request(`https://${this.endpoint}${path}`, {
			method: overrideMethod,
			headers,
			signal: AbortSignal.timeout(timeout),
			// @ts-expect-error: will fix cuz typescript version change
			body: Trequest,
		});
		let response: Response;
		if (this.shouldUseLegyEncryptedRequest(path, headers)) {
			response = await this.legyTransport.fetch(request, this.client.fetch, {
				application: this.systemType,
				userAgent: this.userAgent,
				endpoint: this.client.legy.endpoint,
			});
			// The encrypted gateway (/enc) can reject every request with an empty
			// 404 while the plain path keeps working (#280). In "auto" mode, send
			// the same request over the plain path instead of failing, and skip
			// /enc for a while so each call does not pay for a rejected round trip.
			if (this.client.legy.encrypted === "auto" && (await isLegyGatewayRejection(response))) {
				this.#legyRejectedUntil = Date.now() + LEGY_REJECTION_BACKOFF_MS;
				this.client.log("legyFallback", { path, methodName, until: this.#legyRejectedUntil });
				response = await this.client.fetch(
					new Request(`https://${this.endpoint}${path}`, {
						method: overrideMethod,
						headers,
						signal: AbortSignal.timeout(timeout),
						// @ts-expect-error: will fix cuz typescript version change
						body: Trequest,
					}),
				);
			}
		} else {
			response = await this.client.fetch(request);
		}
		const nextToken = response.headers.get("x-line-next-access");
		if (nextToken) {
			this.client.emit("update:authtoken", nextToken);
		}
		const body = await response.arrayBuffer();
		const parsedBody = new Uint8Array(body);
		this.client.log("response", {
			...response,
			parsedBody,
			methodName,
		});
		let res: ParsedThrift;
		let hasError = false;
		try {
			res = this.client.thrift.readThrift(parsedBody, protocol);
		} catch {
			throw new Error(
				`Request internal failed: status=${response.status} ` +
					`headers=${JSON.stringify([...response.headers.entries()])} ` +
					`body=<${[...parsedBody].map((e) => e.toString(16)).join(" ")}>`,
			);
		}
		if (!res.data[0] && Object.keys(res.data).length) {
			hasError = true;
		}
		if (parse === true) {
			this.client.thrift.rename_data(res, square.includes(path));
		} else if (typeof parse === "string") {
			res.data.success = this.client.thrift.rename_thrift(parse, res.data[0]);
			delete res.data[0];
			if (res.data[1]) {
				const structName = RequestClient.EXCEPTION_TYPES[path] || "TalkException";
				if (structName) {
					res.data.e = this.client.thrift.rename_thrift(structName, res.data[1]);
				} else {
					res.data.e = res.data[1];
				}
				delete res.data[1];
			}
		} else {
			res.data.success = res.data[0];
			delete res.data[0];
			if (res.data[1]) {
				const structName = RequestClient.EXCEPTION_TYPES[path] || "TalkException";
				if (structName) {
					res.data.e = this.client.thrift.rename_thrift(structName, res.data[1]);
				} else {
					res.data.e = res.data[1];
				}
				delete res.data[1];
			}
		}

		this.client.log("readThrift", {
			res,
		});

		const isRefresh = Boolean(
			res.data.e &&
			res.data.e.code === "MUST_REFRESH_V3_TOKEN" &&
			(await this.client.storage.get("refreshToken")),
		);

		if (res.data.e && !isRefresh) {
			throw new InternalError(
				"RequestError",
				`Request internal failed, ${methodName}(${path}) -> ` + JSON.stringify(res.data.e),
				res.data.e,
			);
		}
		if (hasError && !isRefresh) {
			if (res.data.e?.code === "NOT_AUTHORIZED_DEVICE") {
				delete this.client.authToken;
				this.client.emit("end", this.client.profile!);
			}
			throw new InternalError(
				"RequestError",
				`Request internal failed, ${methodName}(${path}) -> ` + JSON.stringify(res.data),
				res.data,
			);
		}

		if (isRefresh && !isReRequest) {
			await this.client.auth.tryRefreshToken();
			return this.requestCore(
				path,
				value,
				methodName,
				protocolType,
				appendHeaders,
				overrideMethod,
				parse,
				true,
			);
		}
		return res;
	}

	/**
	 * Get HTTP headers for a request.
	 * @param {string} [overrideMethod="POST"] The HTTP method to use in the `x-lhm` header.
	 * @returns {Record<string, string>} An object with the headers as key-value pairs.
	 */
	public getHeader(overrideMethod: string = "POST"): Record<string, string> {
		const header = {
			Host: this.endpoint,
			accept: "application/x-thrift",
			"user-agent": this.userAgent,
			"x-line-application": this.systemType,
			"content-type": "application/x-thrift",
			"x-lal": "ja_JP",
			"x-lpv": "1",
			"x-lhm": overrideMethod,
			"accept-encoding": "gzip",
		} as Record<string, string>;

		if (this.client.authToken) {
			header["x-line-access"] = this.client.authToken;
		}

		return header;
	}

	private get legyTransport(): LegyEncryptedTransport {
		return (this.#legyTransport ??= new LegyEncryptedTransport(this.client.legy.endpoint));
	}

	private shouldUseLegyEncryptedRequest(path: string, headers: Record<string, string>): boolean {
		const mode = this.client.legy.encrypted;
		if (mode === false) return false;
		if (!headers["x-line-access"]) return false;
		if (mode === true) return true;
		if (Date.now() < this.#legyRejectedUntil) return false;
		return isLegyTalkPath(path) && shouldUseLegyEncryptedAccess(headers["x-line-access"]);
	}
}

const LEGY_REJECTION_BACKOFF_MS = 10 * 60 * 1000;

/**
 * An empty-body 404 from `server: legy` on /enc means the gateway refused the
 * encrypted request before it reached the service (#280). A real Thrift
 * response always carries a body, so this cannot be confused with an API error.
 */
export async function isLegyGatewayRejection(response: Response): Promise<boolean> {
	if (response.status !== 404) return false;
	if ((response.headers.get("server") ?? "").toLowerCase() !== "legy") return false;
	return (await response.clone().arrayBuffer()).byteLength === 0;
}

function isLegyTalkPath(path: string): boolean {
	return (
		path === "/S3" ||
		path === "/S4" ||
		path === "/V4" ||
		path === "/SYNC3" ||
		path === "/SYNC4" ||
		path === "/P4" ||
		path === "/P5" ||
		path === "/NP4" ||
		path === "/NP5" ||
		path === "/C5" ||
		path === "/CA5" ||
		path === "/ECA5"
	);
}
