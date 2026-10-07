// dsh-chat-seamless-history — browser half（本地插件）
//
// 目的：聊天记录向上滚动接近顶部时，自动加载更早的历史消息 —— 不需要手动
// 点「加载更早」按钮，视觉位置零跳动，滚到历史尽头自动停止。
//
// 机制（为什么不自己发请求、而是"替你点官方按钮"）：
//   官方 dsh-client-ui-chat 的 ChatView 在 hasMore 时渲染
//     <div class="*_older"><button disabled={loadingOlder} onClick={scroll.loadEarlier}>
//   loadEarlier() 的完整链路是：
//     navigation.loadEarlier()
//       → viewport.beginPaging()    // 锁定第一个可见行为为分页锚点 [data-chat-paging-anchor]
//       → reading.pauseFollowing()
//       → loadOlder()               // 拉上一页，新内容插到列表顶部
//       → viewport.preserve()       // 把锚点行补偿回加载前的视口位置（零跳动）
//   官方的位置保持机制已经完备 —— 点按钮加载本来就不跳，唯一缺口是"要手动点"。
//   本插件只做一件事：滚动接近顶部时自动 click 那个官方按钮，完全复用原路径，
//   不碰任何内部状态。
//
// 链式加载为什么能自然形成：
//   preserve() 补偿位置时会写 scroller.scrollTop → 触发 scroll 事件 → 本插件
//   再次评估 → 若补偿后仍处于阈值内（新一页不够高）就继续点，直到离开阈值区
//   或 hasMore=false（此时按钮整个不渲染，天然终止）。
//   另挂一个 document 级 MutationObserver（attributeFilter=disabled）：加载完成
//   disabled true→false 时复查一次，补齐"加载完但无 scroll 事件"的断链场景。
//
// 防御：
//   - 按钮不存在 / disabled（加载中）→ 不触发
//   - 文本校验（"加载更早" / "Load earlier"）+ 结构定位（column 第一个子元素
//     里的裸 button），类名 hash（icaHSq_*）只作 fallback —— 升级不脆断
//   - 250ms 最小触发间隔；连续 3 次触发位置都没挪 ≥40px（无进展，例如加载
//   失败）→ 进入 8s 冷却，位置显著变化才重置
//   - 滚动事件 rAF 合帧；会话切换后 detached 的 scroller 直接忽略
//     （状态存 WeakMap，随 scroller 被 GC 自动清空）
//
// 开关（沿用 polish 的 dataset 约定，host 启动前在 <html> 上设置）：
//   html[data-seamless-history="native"]                 → 整体关闭
//   html[data-seamless-history-threshold="480"]          → 触发阈值（px，默认 320）
//   运行中改 dataset 立即生效，无需刷新。
//
// 卸载/回滚：删掉 profile cordis.patch.yml 里的 insert 行 + node_modules 链接 +
// package.json 依赖行，重启应用即可（host 在启动时就把 client bundle 读进内存，
// 刷新页面对"新插件注册"无效）。
window.__ModuleLoader__.load({
	id: "dsh-chat-seamless-history",
	factory: (require) => {
		const module = { exports: {} };

		const DEFAULT_THRESHOLD = 320; // px from top before auto-loading kicks in
		const MIN_INTERVAL_MS = 250; // hard anti-double-fire interval
		const STUCK_DELTA_PX = 40; // "no progress" = trigger-to-trigger movement below this
		const STUCK_LIMIT = 3; // no-progress triggers before cooldown
		const COOLDOWN_MS = 8000; // retry interval while stuck
		// Official locale strings for chat.loadOlder (bundle-verified 0.2.0-rc.2).
		const LABELS = new Set(["加载更早", "Load earlier"]);

		/* ---------------- switches (read live, cheap) ---------------- */
		const root = () => document.documentElement;
		const enabled = () => root().dataset.seamlessHistory !== "native";
		const threshold = () => {
			const raw = Number(root().dataset.seamlessHistoryThreshold);
			return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
		};

		/* ---------------- state (per scroller, GC-friendly) ---------------- */
		const state = new WeakMap(); // scroller -> { lastAt, lastTop, stuck }
		let lastChatScroller = null; // most recent live chat scroller seen on scroll
		let rafPending = false;

		/* ---------------- DOM resolution ----------------
		 * ChatView 结构（0.2.0-rc.2，bundle 实证，attach() 源码为准）：
		 *   div.scrollBody[data-conversation-scroll]   ← 真正的滚动容器（官方
		 *     │                                          attach(): list.closest("[data-conversation-scroll]") ?? list）
		 *     ├ … > div.root[data-chat-following-tail]
		 *     │       └ div.scroll                ← listRef（仅无共享 scrollport 时才是 scroller）
		 *     │           └ div.column[data-chat-flow]
		 *     │               ├ div.older > button   ← hasMore 时是 column 的第一个子元素
		 *     │               └ ChatNodeList…
		 *     └ div[data-composer-seat]
		 * 即 column 是 scroller 的**深层后代**，判定不能用 ":scope >"。
		 */
		function isChatScroller(el) {
			if (!el || !el.querySelector) return false;
			// 共享 scrollport 形态（desktop 会话视图常态）
			if (el.matches && el.matches("[data-conversation-scroll]") && el.querySelector(":scope [data-chat-flow]")) return true;
			// 独立形态（无共享 scrollport 的 fallback：listRef 自己滚）
			return !!el.querySelector(":scope > [data-chat-flow]");
		}

		function labelOk(btn) {
			return LABELS.has((btn.textContent || "").trim());
		}

		/** 结构定位优先（hasMore 时 older div 恒为 column 首子），类名仅 fallback。 */
		function findLoadButton(scroller) {
			const flow = scroller.querySelector("[data-chat-flow]");
			if (flow) {
				const first = flow.firstElementChild;
				if (first && first.tagName === "DIV") {
					const btn = first.querySelector(":scope > button");
					if (btn && !btn.disabled && labelOk(btn)) return btn;
				}
			}
			// compiled css-module class, hash prefix may drift across versions
			const alt = scroller.querySelector("[data-chat-flow] [class*='_older'] > button");
			if (alt && !alt.disabled && labelOk(alt)) return alt;
			return null;
		}

		/* ---------------- core check ---------------- */
		function check(scroller) {
			if (!scroller || !enabled()) return;
			if (!scroller.isConnected) return; // stale session's detached scroller
			if (scroller.scrollTop > threshold()) return; // not near the top (includes tail-following)
			const btn = findLoadButton(scroller);
			if (!btn) return; // hasMore=false → nothing to load, natural stop
			if (btn.disabled) return; // a page is already in flight
			const now = Date.now();
			const s = state.get(scroller) || { lastAt: 0, lastTop: -1, stuck: 0 };
			if (now - s.lastAt < MIN_INTERVAL_MS) return;
			if (Math.abs(scroller.scrollTop - s.lastTop) >= STUCK_DELTA_PX) {
				s.stuck = 0; // real movement since last trigger
			} else if (s.stuck >= STUCK_LIMIT) {
				if (now - s.lastAt < COOLDOWN_MS) return; // load erroring out: back off
			} else {
				s.stuck += 1;
			}
			s.lastAt = now;
			s.lastTop = scroller.scrollTop;
			state.set(scroller, s);
			btn.click(); // official path: beginPaging → loadOlder → preserve
		}

		function scheduleCheck() {
			if (rafPending) return;
			rafPending = true;
			requestAnimationFrame(() => {
				rafPending = false;
				check(lastChatScroller);
			});
		}

		/* ---------------- lifecycle ----------------
		 * 客户端 Loader 把 factory 返回的 exports 直接当插件本体应用（cordis 认
		 * 函数，或带 apply 方法的对象）：监听器只能在 apply 里注册、用 ctx.effect
		 * 返回清理函数。若把注册留在 factory 期、只返回自省对象，web boot 会以
		 * “invalid plugin … received object” 起不来（0.2.0-rc.2 起是致命错误）。
		 */
		// capture: scroll events don't bubble, so document-level capture is the
		// only delegation point — and it survives every session switch / remount.
		const onScroll = (e) => {
			const t = e.target;
			if (t && t.nodeType === 1 && isChatScroller(t)) {
				lastChatScroller = t;
				scheduleCheck();
			}
		};

		function apply(ctx) {
			// observable mount marker: <html data-seamless-history-active="1"> proves
			// apply() actually ran (survives any "did the client half even load" doubt)
			document.documentElement.dataset.seamlessHistoryActive = "1";
			console.debug("[dsh-chat-seamless-history] apply() mounted — auto-load armed");
			window.addEventListener("scroll", onScroll, { capture: true, passive: true });

			// Catch "page finished loading" (disabled true→false) even when the user
			// isn't scrolling: chains until the position clears the threshold.
			let moPending = false;
			const mo = new MutationObserver(() => {
				if (moPending) return;
				moPending = true;
				requestAnimationFrame(() => {
					moPending = false;
					check(lastChatScroller);
				});
			});
			const startObserver = () => {
				if (document.body) {
					mo.observe(document.body, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ["disabled", "class"]
					});
				} else {
					document.addEventListener("DOMContentLoaded", startObserver, { once: true });
				}
			};
			startObserver();

			ctx.effect(() => () => {
				window.removeEventListener("scroll", onScroll, { capture: true });
				document.removeEventListener("DOMContentLoaded", startObserver);
				mo.disconnect();
				lastChatScroller = null;
				delete document.documentElement.dataset.seamlessHistoryActive;
			}, "dsh-chat-seamless-history: scroll listener + history observer");
		}

		module.exports = {
			apply,
			inject: [],
			/* introspection for tests */ check, findLoadButton, isChatScroller,
		};
		return module.exports;
	}
});
