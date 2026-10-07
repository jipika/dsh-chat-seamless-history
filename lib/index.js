// dsh-chat-seamless-history — node half: no-op host entry so a cordis row can
// mount the browser bundle. All behaviour lives in ./client.js.
export const name = "dsh-chat-seamless-history";
export const inject = [];
export function apply() {
	console.log("[dsh-chat-seamless-history] host half mounted (client-only plugin)");
}
