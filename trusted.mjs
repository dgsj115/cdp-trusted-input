#!/usr/bin/env node
// 通过 CDP 向浏览器发送"可信"（isTrusted === true）的鼠标事件。
//
// 为什么需要这个：
//   页面里 dispatchEvent(new MouseEvent('click')) 造出来的事件，isTrusted 是 false。
//   做了校验的站点会直接忽略它，而且这个值页面脚本改不了。唯一能产生
//   isTrusted === true 的办法，是让输入**从浏览器自己的输入管线里走一遍**。
//   CDP 的 Input.* 域就是这个入口。
//
// 零依赖：Node 22+ 自带 WebSocket 和 fetch，不需要 puppeteer。

const DEFAULTS = { port: 9222, selector: "#target", url: null };

function parseArgs(argv) {
  const out = { ...DEFAULTS, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--port") out.port = Number(next());
    else if (a === "--selector" || a === "-s") out.selector = next();
    else if (a === "--url") out.url = next();
    else if (a === "--list") out.list = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const USAGE = `
用法: node trusted.mjs [选项]

  -s, --selector <css>   要点击的元素，默认 "#target"
      --port <n>         调试端口，默认 9222
      --url <substr>     目标标签页 URL 里包含的子串（有多个标签页时用来指定）
      --list             只列出当前标签页，不点击
  -h, --help             显示这段帮助

示例:
  node trusted.mjs --list
  node trusted.mjs -s "#submit" --url demo.html
`;

/* ------------------------------ 极简 CDP 客户端 ------------------------------ */

class CDP {
  #ws; #id = 0; #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = this.#pending.get(msg.id);
      if (!p) return;                    // 事件通知（没有 id），忽略
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.#ws.close(); }
}

async function connect(port, urlFilter) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (e) {
    throw new Error(
      `连不上调试端口 ${port}。确认浏览器是这样启动的：\n` +
      `  msedge.exe --remote-debugging-port=${port}\n` +
      `（端口连得上但一直 404，通常是浏览器进程假死，完全退出再重开）\n` +
      `原始错误: ${e.message}`
    );
  }

  const pages = targets.filter((t) => t.type === "page");
  if (urlFilter) {
    const hit = pages.find((t) => t.url.includes(urlFilter));
    if (!hit) throw new Error(`没有 URL 含 "${urlFilter}" 的标签页`);
    return { ...(await open(hit)), target: hit };
  }

  // 默认挑第一个非 about:blank 的页面
  const target = pages.find((t) => !t.url.startsWith("about:")) || pages[0];
  if (!target) throw new Error("没有可用的标签页");
  return { ...(await open(target)), target };
}

async function open(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  return { cdp: new CDP(ws) };
}

/* --------------------------------- 点击 --------------------------------- */

async function centerOf(cdp, selector) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return JSON.stringify({ err: "元素尺寸为 0，可能不可见" });
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`,
    returnByValue: true,
  });

  if (!result.value) throw new Error(`页面上找不到元素: ${selector}`);
  const parsed = JSON.parse(result.value);
  if (parsed.err) throw new Error(`${selector}: ${parsed.err}`);
  return parsed;
}

async function click(cdp, selector) {
  const { x, y } = await centerOf(cdp, selector);

  // 真实用户不会隔空点击：先移过去，再按下，再抬起。
  // 很多站点监听 pointerdown/pointerup，而合成一个 MouseEvent('click')
  // 只会触发 click，压根没有 pointer 阶段——这也是被识破的原因之一。
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });

  return { x: Math.round(x), y: Math.round(y) };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void console.log(USAGE);

  const { cdp, target } = await connect(opts.port, opts.url);

  if (opts.list) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
    });
    console.log(JSON.parse(result.value));
    return void cdp.close();
  }

  console.log(`目标标签页: ${target.title || "(无标题)"}  ${target.url}`);
  const { x, y } = await click(cdp, opts.selector);
  console.log(`已在 (${x}, ${y}) 点击 ${opts.selector}`);
  cdp.close();
}

main().catch((e) => {
  console.error("错误:", e.message);
  process.exit(1);
});
