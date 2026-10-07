// dsh-chat-seamless-history — offline smoke test.
// Runs the real lib/client.js inside a vm sandbox with a stub DOM and asserts
// the trigger matrix: both scroller shapes (shared scrollport + standalone),
// threshold band, disabled/missing button, label check, stuck cooldown,
// movement reset, the dataset kill-switch, and the apply() mount marker.
//   node tests/smoke-test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../lib/client.js"), "utf8");

/**
 * Shared scrollport shape (desktop conversation view, the common case):
 *   scroller[data-conversation-scroll] > … > .scroll > .column[data-chat-flow]
 * Standalone shape (official fallback `?? list`):
 *   scroller(.scroll) > .column[data-chat-flow]
 */
function makeEnv({ shared = true, hasBtn = true, btnDisabled = false, label = "加载更早" } = {}) {
	let now = 1_000_000;
	const clicks = [];
	const btn = hasBtn
		? { textContent: label, disabled: btnDisabled, click: () => clicks.push(now) }
		: null;
	const olderDiv = { tagName: "DIV", querySelector: (sel) => (sel === ":scope > button" && btn ? btn : null) };
	const flow = { firstElementChild: olderDiv };
	const scroller = {
		nodeType: 1,
		isConnected: true,
		scrollTop: 100,
		matches: (sel) => shared && sel === "[data-conversation-scroll]",
		querySelector: (sel) => {
			if (sel === "[data-chat-flow]") return flow;
			if (sel === ":scope [data-chat-flow]") return shared ? flow : null;
			if (sel === ":scope > [data-chat-flow]") return shared ? null : flow;
			if (sel === "[data-chat-flow] [class*='_older'] > button") return null;
			return null;
		},
	};
	let scrollHandler = null;
	const documentElement = { dataset: {} };
	let moduleExports = null;
	const sandbox = {
		console,
		Date: { now: () => now },
		requestAnimationFrame: (fn) => fn(), // synchronous: scroll → check immediately
		MutationObserver: class { observe() {} },
		document: {
			documentElement,
			body: {},
			addEventListener: () => {},
		},
		window: {
			__ModuleLoader__: { load: (def) => { moduleExports = def.factory({}); } },
			addEventListener: (type, fn) => { if (type === "scroll") scrollHandler = fn; },
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "client.js" });
	assert.ok(moduleExports && typeof moduleExports.apply === "function", "exports is a cordis {apply} plugin");
	return {
		scroller, btn, clicks, documentElement, exports: () => moduleExports,
		advance: (ms) => { now += ms; },
		fireScroll: (top) => {
			assert.ok(scrollHandler, "apply() ran before any scroll (listener registered in apply)");
			if (top !== undefined) scroller.scrollTop = top;
			scrollHandler({ target: scroller });
		},
		setDataset: (k, v) => { documentElement.dataset[k] = v; },
	};
}

let pass = 0;
function t(name, fn) { fn(); pass += 1; console.log(`  ok  ${name}`); }

/* 0. apply() runs and leaves the observable mount marker */
t("apply() mounts and sets the html dataset marker", () => {
	const e = makeEnv();
	const disposed = [];
	e.exports().apply({ effect: (fn, name) => { disposed.push(name); return fn(); } });
	assert.strictEqual(e.documentElement.dataset.seamlessHistoryActive, "1");
	assert.ok(disposed.length === 1, "one effect registered");
});

/* 1. shared scrollport shape fires */
t("fires on the shared scrollport shape", () => {
	const e = makeEnv({ shared: true });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 1);
});

/* 2. standalone shape fires too */
t("fires on the standalone scroller shape", () => {
	const e = makeEnv({ shared: false });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 1);
});

/* 3. outside the band → silent */
t("stays silent when scrollTop is below the threshold", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(5000);
	assert.strictEqual(e.clicks.length, 0);
});

/* 4. button disabled (page in flight) → silent */
t("stays silent while the button is disabled", () => {
	const e = makeEnv({ btnDisabled: true });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 0);
});

/* 5. button missing (hasMore=false) → silent */
t("stays silent when the button is not rendered", () => {
	const e = makeEnv({ hasBtn: false });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 0);
});

/* 6. wrong label → structural hit alone is not enough */
t("verifies the button label", () => {
	const e = makeEnv({ label: "复制" });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 0);
});

/* 7. English locale works too */
t("accepts the English label", () => {
	const e = makeEnv({ label: "Load earlier" });
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 1);
});

/* 8. repeated triggers without movement → cooldown after STUCK_LIMIT fires */
t("backs off after repeated no-progress triggers", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100); assert.strictEqual(e.clicks.length, 1); // stuck=0 (first)
	e.advance(300); e.fireScroll(100); assert.strictEqual(e.clicks.length, 2); // stuck=1
	e.advance(300); e.fireScroll(100); assert.strictEqual(e.clicks.length, 3); // stuck=2
	e.advance(300); e.fireScroll(100); assert.strictEqual(e.clicks.length, 4); // stuck=3
	e.advance(300); e.fireScroll(100); assert.strictEqual(e.clicks.length, 4); // cooled down
	e.advance(8000); e.fireScroll(100); assert.strictEqual(e.clicks.length, 5); // one retry per cooldown
});

/* 9. real movement resets the stuck counter → chained loading stays live */
t("movement resets the cooldown counter", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.fireScroll(100);
	e.advance(300); e.fireScroll(80);
	e.advance(300); e.fireScroll(300); // preserve() pushed scrollTop up: big movement
	e.advance(300); e.fireScroll(60); // user keeps scrolling up
	assert.strictEqual(e.clicks.length, 4);
});

/* 10. kill switch */
t("dataset kill switch disables everything", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.setDataset("seamlessHistory", "native");
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 0);
});

/* 11. custom threshold */
t("threshold is overridable via dataset", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.setDataset("seamlessHistoryThreshold", "5000");
	e.fireScroll(4000);
	assert.strictEqual(e.clicks.length, 1);
});

/* 12. detached scroller (stale session) → ignored */
t("ignores detached scrollers", () => {
	const e = makeEnv();
	e.exports().apply({ effect: (fn) => fn() });
	e.scroller.isConnected = false;
	e.fireScroll(100);
	assert.strictEqual(e.clicks.length, 0);
});

console.log(`\n${pass} assertions passed`);
