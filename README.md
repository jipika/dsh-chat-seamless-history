# dsh-chat-seamless-history

<p align="center"><img src="./assets/icon.svg" width="48" alt="logo"/></p>

**Seamless chat history for DeepSeek Harness (dsh).** Scrolling near the top of a conversation automatically loads older messages — no manual "Load earlier" click, no visual jump, stops naturally at the beginning of history.

Pure DOM client plugin. No bundle changes, no monkey-patching of internals.

## How it works

The official `ChatView` (package `@deepseek-ai/dsh-client-ui-chat`) renders a `Load earlier` button whenever `hasMore`. Its `onClick` path already implements full read-position anchoring:

```
navigation.loadEarlier()
  → viewport.beginPaging()   // retain first visible row as paging anchor
  → reading.pauseFollowing()
  → loadOlder()              // fetch previous page, prepend to list
  → viewport.preserve()      // compensate scroll so the anchor row stays put
```

So the click path is already seamless — the only gap is that it requires a manual click. This plugin simply clicks that official button for you when the scroller gets within a threshold of the top, reusing the exact same path (no internal state touched).

Chained loading forms naturally: `preserve()` writes `scrollTop` back, which fires another scroll event, which re-evaluates — so pages keep loading until you leave the threshold band or `hasMore` turns false (the button stops rendering → natural stop). A document-level `MutationObserver` on `disabled` re-checks when a page finishes loading, closing the "loaded but no scroll event" gap.

## Safety rails

- Button absent (history exhausted) or `disabled` (page in flight) → never triggers
- Button identified structurally (first child of `[data-chat-flow]` containing a bare `button`) with text verification (`加载更早` / `Load earlier`); the compiled css-module class is only a fallback, so hash changes across versions don't break it
- 250 ms minimum interval between triggers; 3 consecutive no-progress triggers (< 40 px movement, e.g. load errors) → 8 s cooldown, reset by real movement
- Scroll events coalesced per animation frame; per-scroller state lives in a `WeakMap`, so session switches leave nothing behind; detached scrollers are ignored

## Switches

Set on `<html>` (dataset), effective immediately, no reload needed:

| dataset key | effect |
|---|---|
| `data-seamless-history="native"` | turn the whole feature off |
| `data-seamless-history-threshold="480"` | trigger distance from top in px (default `320`) |

## Install (local plugin)

1. Package lives in `~/.dsh/local-plugins/dsh-chat-seamless-history/`
2. `~/.dsh/profiles/desktop/package.json`: add `"dsh-chat-seamless-history": "link:../../local-plugins/dsh-chat-seamless-history"` to dependencies
3. Symlink `~/.dsh/profiles/desktop/node_modules/dsh-chat-seamless-history -> ../../../local-plugins/dsh-chat-seamless-history`
4. `~/.dsh/profiles/desktop/cordis.patch.yml`: add the `- insert: {id, name}` row
5. Restart the app (new plugin *registration* is host-side; a page refresh only picks up code changes of already-registered plugins)

## Rollback

Remove the dependency row, the symlink, and the patch insert row; restart. Nothing else is touched.

## License

MIT
