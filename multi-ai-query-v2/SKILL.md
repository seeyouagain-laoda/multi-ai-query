---
name: multi-ai-query-v2
description: 同时向 DeepSeek、千问、Kimi 等多个AI提问并自动汇总答案。ChatGPT/Perplexity默认禁用（需外网），单个AI失败不影响其他。支持 config.json 配置。
agent_created: true
---

# 多AI查询 V2 — 重新设计的自动化查询工具

## 相比 V1 的改进

| 特性 | V1 | V2 |
|------|----|----|
| 配置 | 硬编码 | `config.json` 统一配置 |
| ChatGPT/Perplexity | 默认启用 | **默认禁用**（外网用户可手动开启） |
| 单个AI失败 | 可能影响整体 | **完全隔离，不影响其他AI** |
| 代码结构 | 单文件470行 | 模块化拆分 |
| 新AI接入 | 改核心代码 | 加配置文件即可 |

## 触发方式
- "多AI查询 V2"
- "问一下AI们"
- "用多个AI回答"

## 配置说明

编辑 `config.json` 即可控制：
- 启用/禁用某个AI（`"enabled": true/false`）
- 调整等待时间
- 修改Chrome路径

ChatGPT和Perplexity默认禁用（需要外网），启用方法：
```json
"chatgpt": { "enabled": true },
"perplexity": { "enabled": true }
```
