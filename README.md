# Multi-AI Query V2.1

> ⚠️ **免责声明**：本项目代码由 AI 辅助生成，仅供学习参考。使用本项目操作第三方网站可能违反其服务条款，请自行评估风险。作者不对因使用本项目产生的任何后果承担责任。

## 项目简介

**多AI查询工具** — 通过 Chrome DevTools Protocol (CDP) 同时控制 5 个主流 AI 网站，向它们提出同一问题，收集所有回答后用 DeepSeek 自动生成综合总结报告。

### 一句话概括

> 输入一个问题 → 自动问 5 个 AI → 汇总最精华的答案给你

### 支持的 AI 平台

| AI | 默认状态 | 模型配置 | 特点 |
|----|---------|---------|------|
| **Perplexity** | ✅ 启用 | GPT-5.4 Thinking | 引用来源清晰，需外网 |
| **千问 (Qwen)** | ✅ 启用 | Qwen3-Max-Thinking | 中文能力强，自动刷新+选模型 |
| **DeepSeek** | ✅ 启用 | 深度思考 + 智能搜索 | 逻辑推理强，用于最终总结 |
| **Kimi** | ✅ 启用 | K2.6 思考 | 长文本处理，联网搜索 |
| **ChatGPT** | ✅ 启用 | 默认 | 综合能力强，需外网 |

> **外网说明**：ChatGPT 和 Perplexity 需要科学上网。如果它们无法连接，脚本会自动检测并禁用，下次不再重试。你需要手动将 `config.json` 中对应的 `enabled` 改回 `true` 才能重新启用。

---

## 更新日志

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.1 | 2026-05-31 | 新增 `weight` 权重排序、`responseClass` CSS选择器配置、`--format` 输出格式参数、用DeepSeek做总结 |
| v2.0 | 2026-05-31 | 完全模块化重写，`config.json` 统一配置，错误隔离，自动禁用不可达AI |
| v1.0 | 2026-05-31 | 初始版本，5个AI串行发送+并行提取 |

---

## 目录

- [前置条件](#前置条件)
- [快速开始](#快速开始)
- [配置文件详解](#配置文件详解)
- [架构与工作流程](#架构与工作流程)
- [模块说明](#模块说明)
- [命令与参数](#命令与参数)
- [常见问题与踩坑记录](#常见问题与踩坑记录)
- [技术细节](#技术细节)
- [设计决策](#设计决策)
- [贡献](#贡献)

---

## 前置条件

### 硬件要求
- 任何能运行 Chrome 的电脑（Windows/macOS/Linux）
- 至少 8GB 内存（Chrome 同时开 5 个标签页）

### 软件要求
1. **Node.js** >= 18（推荐 22+）
2. **Chrome 浏览器**（已安装，版本无要求）
3. **npm 包**：`ws`（WebSocket 库）

### 账号要求（必须）
5 个 AI 网站都需要**手动登录一次**。登录后 Chrome 会保存 cookie 到 `user-data` 目录，后续脚本自动复用。

**登录方法**：
1. 用 Chrome 正常打开各 AI 网站
2. 使用你的账号登录（手机号/邮箱/GitHub/Google 均可）
3. 确认能正常对话后关闭浏览器即可

> ⚠️ **注意**：如果 cookie 过期，脚本检测到输入框不可用时会报错，你需要重新手动登录。

---

## 快速开始

### 1. 安装依赖

```bash
cd multi-ai-query-v2
npm install ws
```

### 2. 确保 Chrome 已登录 5 个 AI

```bash
# 手动打开 Chrome，登录 5 个 AI 网站，然后关闭
# 这一步只需要做一次
```

### 3. 运行

```bash
node index.js "你的问题"
```

**效果**：脚本会自动：
1. 启动/连接 Chrome（端口 18800）
2. 找到或创建 5 个 AI 标签页
3. 检测登录状态
4. 从慢到快逐个发送问题（Perplexity → 千问 → DeepSeek → Kimi → ChatGPT）
5. 等所有 AI 开始思考后，并行提取回复
6. 用 DeepSeek 生成综合总结

### 4. 对比模式

```bash
node index.js --format comparison "你的问题"
```

对比模式会逐个展示每个 AI 的回答，不加综合总结，方便你对比各家差异。

---

## 配置文件详解

配置文件 `config.json` 控制所有行为。以下是完整结构：

```json
{
  "version": "2.1",            // 配置版本
  "browser": {
    "cdpPort": 18800,          // Chrome 调试端口
    "executablePath": "...",   // Chrome 可执行文件路径
    "userDataDir": "..."       // Chrome 用户数据目录（存登录态）
  },
  "output": {
    "format": "summary",       // 默认输出格式: summary/comparison
    "saveHistory": false       // 是否保存查询历史
  },
  "ais": {
    "perplexity": {
      "name": "Perplexity",
      "url": "https://www.perplexity.ai/",
      "enabled": true,         // 启用/禁用
      "model": "GPT-5.4",      // 要选择的模型
      "inputType": "contenteditable",  // 输入框类型
      "order": 1,              // 发送顺序（1=最先）
      "weight": 0.9,           // 输出权重（影响排序）
      "responseClass": "[class*=\"prose\"]",  // CSS提取选择器
      "description": "需外网，引用来源清晰"
    }
    // ... 其他 AI 类似
  },
  "extraction": {
    "initialWaitMs": 3000,     // 首次等待 AI 思考时间
    "checkIntervalMs": 3000,   // 轮询间隔
    "maxWaitMs": 90000,        // 最大等待时间
    "stabilityChecks": 2       // 稳定次数（连续一致才算完成）
  },
  "summary": {
    "provider": "deepseek",    // 负责总结的 AI
    "waitMs": 20000            // 总结等待时间
  }
}
```

### 关键配置项说明

**`enabled`**：设为 `false` 可跳过该 AI。失败后自动禁用。

**`weight`**：输出排序权重，值越高排越前。千问和 DeepSeek 设 1.0，其他 0.9。

**`responseClass`**：CSS 选择器，用于提取 AI 回答区域。如果选择器匹配失败，会自动降级到 body text 解析。

**`order`**：发送顺序。慢的 AI（Perplexity、千问）先发，给它们更多思考时间。

**`needsRefresh`**（千问特有）：每次提问前刷新页面，清除旧对话历史。

---

## 架构与工作流程

```
用户输入问题
    │
    ▼
┌─────────────────────────┐
│ 1. ensureChrome()       │  Chrome 是否运行？否→启动
│    连接/启动浏览器      │  是→跳过
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│ 2. ensureTabs()         │  逐个 AI 域名匹配已有标签页
│    确保5个标签页就绪    │  找不到则 PUT 创建新标签页
│                         │  等待页面 readyState=complete
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│ 3. 检测登录状态          │  连接每个标签页的 WebSocket
│    宽松检测页面内容      │  检查 body.innerText > 50 字
│                         │  连不上/内容少的自动禁用
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│ 4. 阶段1: 串行发送       │  按 order 顺序逐个操作：
│    从慢到快逐个发送      │  → bringToFront 激活标签页
│                         │  → 注入防后台节流补丁
│                         │  → 配置模型（千问刷新+选模型）
│                         │  → 聚焦输入框 + InsertText 输入
│                         │  → 发送（千问点图标，其他 Enter）
│                         │  → 等 2 秒 → 下一个 AI
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│ 5. 阶段2: 并行提取       │  所有 AI 同时提取回复
│    Promise.allSettled    │  每个 AI 独立：
│    稳定性检测            │  → 千问：bringToFront 激活后提取
│                         │  → 每 3 秒检查一次，最多 90 秒
│                         │  → 连续两次内容一致才算完成
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│ 6. 输出 + 总结           │  → 按权重排序展示各 AI 回答
│    权重排序 + DeepSeek  │  → DeepSeek 自动生成综合总结
│    自动汇总              │  → 失败 AI 自动禁用（写回 config）
└─────────────────────────┘
    │
    ▼
  最终结果
```

---

## 模块说明

| 函数 | 作用 | 关键逻辑 |
|------|------|---------|
| `ensureChrome()` | 启动/连接 Chrome | 不杀已有进程，复用端口 18800 |
| `ensureTabs()` | 确保标签页就绪 | 匹配域名 → 创建 → 等待加载（并行） |
| `sendOne(ai, q)` | 向单个 AI 发送问题 | 配置模型 → 聚焦 → 输入 → 发送 |
| `extractOne(ai)` | 提取单个 AI 回复 | 千问特殊处理 → 稳定性检测 |
| `tryExtract()` | DOM 提取核心 | 千问 marker → responseClass → body 差值 |

---

## 命令与参数

```bash
# 基本用法
node index.js "你的问题"

# 对比模式（不加总结）
node index.js --format comparison "你的问题"

# 指定问题（第二种写法）
node index.js --format summary "你的问题"
```

### 输出格式

| 格式 | 说明 | 适用场景 |
|------|------|---------|
| `summary`（默认） | 逐个展示 + DeepSeek 综合总结 | 快速获取最优答案 |
| `comparison` | 逐个展示，不加总结 | 对比各 AI 回答差异 |

---

## 常见问题与踩坑记录

### 1. 千问打开时弹出历史对话弹窗

**原因**：千问每次打开页面时自动弹出历史对话侧边栏（640px 浮层），遮挡了主界面。

**解决**：脚本中通过循环 3 次点击 `×` 按钮和 `qwpcicon-close` 图标来关闭。如果弹窗结构变化，需要更新关闭逻辑。

### 2. 千问在后台标签页暂停输出

**原因**：Chrome 会节流后台标签页的 JavaScript 执行，千问的流式输出因此暂停。只有 bringToFront 激活后才能继续。

**解决**：
- 注入页面可见性补丁（重写 `document.hidden` 和 `document.visibilityState`）
- 使用 CDP `Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState`
- 千问提取前强制 `Page.bringToFront` + 等 3 秒

### 3. 千问刷新后模型和思考设置丢失

**原因**：`Page.reload()` 会重置所有页面状态。

**解决**：用 `Page.navigate()` 导航到干净 URL，然后重新选模型+开思考。

### 4. Input.insertText 比 JS innerText 更可靠

**原因**：千问的输入框是一个 React contenteditable 组件，直接用 JS 设置 `innerText` 不会触发 React 的 onChange 事件，导致发送按钮保持禁用状态。

**解决**：使用 CDP `Input.insertText` 模拟真实键盘输入，React 能正常响应。

### 5. ChatGPT/Perplexity 取到旧回答

**原因**：ChatGPT 和 Perplexity 的页面累积了之前的对话历史，body text 中有大量旧内容。

**解决**：使用 `beforeBody` 长度差值法——发送前记录 body 长度，提取时只取新增部分。同时使用 CSS 选择器（`[data-message-author-role="assistant"]`、`[class*="prose"]`）精准定位新回答。

### 6. Kimi 提取不到回答

**原因**：Kimi 使用虚拟列表渲染对话内容，AI 回答不在 `document.body.innerText` 中，标准 CSS 选择器也难定位。

**当前状态**：已知问题，未解决。尝试了「暴力枚举所有长文本元素」「beforeBody 长度差值」「CSS 选择器」均未能可靠提取。

### 7. Chrome 调试端口被占用

**原因**：端口 18800 被其他进程占用。

**解决**：修改 `config.json` 中的 `cdpPort` 为一个不同的端口（如 9222）。

### 8. PUT /json/new 创建标签页失败

**原因**：Chrome CDP 的 `/json/new` 端点只支持 HTTP PUT 方法，GET 会失败。

**解决**：使用 `http.request()` 的 PUT 方法。

### 9. 后台标签页 CDP 事件不工作

**原因**：Chrome 会限制后台标签页的 CDP 操作。

**解决**：使用串行模式（每次操作前 bringToFront 激活），替代并行模式。

### 10. 稳定性检测避免半成品提取

**原因**：AI 流式输出时，早期提取会拿到不完整的回答。

**解决**：连续两次提取内容一致 + body 不再增长，才算回答完成。

---

## 技术细节

### CDP 协议使用

本项目直接通过 WebSocket 连接 Chrome DevTools Protocol，主要使用以下方法：

| CDP 方法 | 用途 |
|----------|------|
| `Runtime.evaluate` | 在页面中执行 JavaScript |
| `Input.insertText` | 模拟输入文字 |
| `Input.dispatchKeyEvent` | 模拟键盘事件（Enter 发送）|
| `Page.bringToFront` | 激活标签页 |
| `Page.navigate` | 导航到新 URL |
| `Page.reload` | 刷新页面 |
| `Page.captureScreenshot` | 截图调试（测试时使用） |
| `Emulation.setFocusEmulationEnabled` | 模拟焦点（防节流） |
| `Page.setWebLifecycleState` | 设置页面活跃状态 |

### 依赖

- `ws` (WebSocket) — 唯一运行时依赖
- Node.js 内置模块：`http`、`child_process`、`fs`、`path`

### 端口

- `18800` — Chrome 远程调试端口

---

## 设计决策

### 为什么用 CDP 而不是 Puppeteer/Playwright？

- **零依赖**：CDP 是 Chrome 内置协议，只需 `ws` 包
- **更轻量**：对比 Puppeteer（~300MB），本项目无头依赖
- **更灵活**：可以控制用户正在使用的 Chrome（保留登录态）
- **直接控制**：不需要额外浏览器驱动

### 为什么串行发送而不是并行？

并行发送时，后台标签页的 CDP 事件会被 Chrome 节流，导致输入不生效。串行发送（每次 bringToFront 激活）虽然慢一点，但更可靠。

### 为什么用 DeepSeek 做总结（v2.1）？

千问（v1）做总结时遇到「搜索模式没有'深度思考已完成'标记」的问题，导致提取失败。DeepSeek 的提取一直稳定可靠，且其 `[class*="message"]` 选择器工作良好。

### 为什么用 beforeBody 长度差值？

各 AI 页面都会累积旧对话历史，body text 中同时存在新旧内容。通过记录发送前的 body 长度，提取时只取新增内容，可以避免拿到旧回答。

---

## 贡献

### 开发流程

```bash
# 克隆仓库
git clone https://github.com/seeyouagain-laoda/multi-ai-query.git
cd multi-ai-query
npm install ws

# 修改代码后测试
node index.js "测试问题"

# 提交
git add -A
git commit -m "描述你的修改"
git push
```

### 添加新的 AI

1. 在 `config.json` 的 `ais` 中添加新条目
2. 如果新 AI 需要特殊处理（如选模型、刷新），在 `sendOne()` 中添加条件分支
3. 如果需要特殊提取逻辑，在 `tryExtract()` 中添加条件分支

### 已知问题

- Kimi 虚拟列表渲染导致提取不可靠
- ChatGPT 页面累积多个回答时可能取到旧内容
- 所有 AI 页面 Cookie 过期需要手动重新登录

---

## License

MIT

---

*本项目代码由 AI 辅助生成。使用前请确保遵守各 AI 平台的服务条款。作者不对使用后果负责。*
