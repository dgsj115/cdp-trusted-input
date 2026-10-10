# cdp-trusted-input

用 CDP 发送**可信**（`isTrusted === true`）鼠标事件。

> Drive real, trusted mouse input into a browser over CDP — no Puppeteer, no dependencies.

## 问题

页面脚本合成的点击长这样：

```js
el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
```

事件**会**到达监听器，但 `event.isTrusted` 是 `false`。做了校验的站点一行 `if (!e.isTrusted) return;` 就把它丢了。而且 `isTrusted` 是只读的，页面脚本改不了，也没法伪造。

把 prompt 提示词那套 `PointerEvent` → `MouseEvent` 全补上也一样，补得再全也是 `false`。

真正的问题不是"事件长得像不像"，而是**它有没有从浏览器的输入管线里走一遍**。合成的 `dispatchEvent` 是页面内部直接调用监听器，绕过了整条管线；`isTrusted` 标记的就是这一点。

## 办法

让输入从外面进来。Chrome DevTools Protocol 的 `Input` 域就是干这个的——它是浏览器的调试输入通道，注入的事件会走完整管线，产出的事件 `isTrusted === true`。

```js
Input.dispatchMouseEvent  { type: 'mouseMoved',    x, y }
Input.dispatchMouseEvent  { type: 'mousePressed',  x, y, button: 'left', buttons: 1, clickCount: 1 }
Input.dispatchMouseEvent  { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
```

这条路径会依次产生 **`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`** 完整事件链，跟真人点一模一样。只监听 `pointerdown` 的站点也照样响应——这也是合成 `MouseEvent('click')` 做不到的：它只有 `click`，压根没有 pointer 阶段。

## 跑起来

**零依赖**，不需要 `npm install`。要求 **Node 22+**（用到内置的 `WebSocket` 和 `fetch`）。

**1. 用调试端口启动浏览器**（需要一个独立的 user-data-dir，否则现有实例会吞掉参数）：

```bash
msedge.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-demo demo.html
# Chrome 同理：
chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-demo demo.html
```

**2. 点击：**

```bash
node trusted.mjs --list                          # 先看有哪些标签页
node trusted.mjs -s "#target" --url demo.html    # 点它
```

## demo.html 演示了什么

页面上的「严格按钮」只统计 `isTrusted === true` 的点击，并把收到的每个事件连同它的 `isTrusted` 打出来。

- 点页面上的**「用 dispatchEvent 合成一次点击」**：五个事件全部送达，全是 `isTrusted=false`，计数纹丝不动。
- 跑 **`node trusted.mjs`**：日志里五个事件全是 `isTrusted=true`，计数 +1。

差别只在事件的来源，不在事件的内容。

## 什么时候用得上

- 自动化**你自己**的 Web 应用或内部工具，而它恰好用了 `isTrusted` 做校验
- E2E 测试里，页面逻辑会过滤掉测试框架注入的合成事件
- 无障碍 / 辅助工具需要模拟真实用户输入
- 复现"只有真人点击才触发"的 bug

`Input` 域还有对应的 `Input.dispatchKeyEvent`、`Input.insertText`，输入框同理——需要往输入框里打字的话，把上面的思路照搬即可。

## 边界

这是通用的浏览器自动化技术，请只用于**你自己拥有或获得授权自动化**的页面。绕过第三方站点的使用条款不在此列。

## 文件

| 文件 | 作用 |
|---|---|
| `trusted.mjs` | 驱动。连 CDP、算元素坐标、发可信鼠标事件。零依赖 |
| `demo.html` | 演示页。并排对比合成事件与可信事件 |
| `LICENSE` | MIT |

## License

MIT
