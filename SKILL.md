---
name: 多ai查询
description: 同时向 DeepSeek、千问、Kimi、ChatGPT、Perplexity
  五个AI提问并自动汇总答案。ChatGPT/Perplexity默认启用，无法连接时自动禁用。支持 config.json 配置、权重排序、多输出格式。v2.2 起兼容 Chrome 151，总结优先走 DeepSeek API（DEEPSEEK_API_KEY 环境变量）。
agent_created: true
---

# 多AI查询 V2.2 — 第3代自动化查询

## 特性

- **5个AI同时查询**：Perplexity → 千问 → DeepSeek → Kimi → ChatGPT（慢到快排序）
- **模型自动配置**：千问(Qwen3-Max-Thinking+思考)、DeepSeek(深度思考+搜索)、Kimi(K2.6思考)、Perplexity(GPT-5.4)
- **智能提取**：稳定性检测（连续两次一致才算完成）+ 增量body差值
- **自动禁用**：ChatGPT/Perplexity连不上时自动禁用，下次不再重试
- **权重排序**：按配置权重排列输出
- **多输出格式**：`--format summary|comparison`
- **配置化**：所有AI参数在 `config.json` 中设置
- **单个AI失败不影响其他**

## v2.2 优化（2026-08-05）

- **Chrome 151 兼容**：启动参数加 `--remote-allow-origins=*`（Chrome 149+ 必需，否则连接被拒）
- **/json/new 修复**：Chrome 151 该端点 URL 参数失效，改为创建空标签页 + `Page.navigate`
- **DeepSeek API 总结**：总结优先调官方 API（读环境变量 `DEEPSEEK_API_KEY`，不写死代码），秒回稳定；无 key 时自动回退网页操作
- **发送失败自动重试 1 次**
- **Cloudflare 验证页检测**：识别验证页明确提示，不再误判为未登录

## 触发方式
- "多AI查询"
- "同时问几个AI"
- "用多个AI回答"

## 配置

编辑 `config.json`，每个AI支持：
- `enabled` — 启用/禁用
- `model` — 模型名称
- `weight` — 输出权重
- `responseClass` — CSS提取选择器
- `inputType` — 输入框类型 (textarea/contenteditable)

## 用法

```bash
# 总结模式（默认，DeepSeek API 或网页）
DEEPSEEK_API_KEY=sk-xxx node index.js "你的问题"

# 对比模式（不加总结）
node index.js --format comparison "你的问题"
```

> ⚠️ **Chrome 要求**：Chrome 149+ 若手动以调试模式启动，需带 `--remote-allow-origins=*`；脚本自动启动时已内置该参数。
