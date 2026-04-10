# Vercel AI Gateway 助手

一个 SillyTavern 三方扩展，把 Vercel AI Gateway 的繁琐参数（`providerOptions` / `reasoning` / `caching`）变成可勾选的 UI，并提供 Key 池管理：余额查询、判活、自动轮询、垃圾盒。

## 功能

- **参数可视化**：勾选供应商、思考强度、缓存模式，实时预览生成的 JSON，一键写入酒馆「包含主体参数」字段
- **模型预设**：内置 Gemini / Claude / GPT / DeepSeek / GLM / Qwen，默认只连官方供应商，可自行编辑预设
- **Key 池**：单加 / 批量加 / 暂停 / 删除
- **余额查询**：调用 `GET /v1/credits`，显示余额和累计消耗
- **自动判活**
  - `200` + 余额充足 → 正常
  - `200` + 余额低 → 余额低
  - `401 / 403` → **死，自动进垃圾盒**
  - `429` → 限流（临时跳过，不算死）
  - `5xx / 网络错误` → 上游错误（临时跳过，不算死）
- **垃圾盒**：死 key 自动归类，可展开查看，支持「恢复」或「彻底清空」
- **自动轮询**：每次酒馆生成前自动切到下一个活 key（写入 `secret_state.api_key_custom`）

## 安装

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/ZZZa-o/vercel-gateway-helper.git
```

或者直接把整个文件夹丢进 `third-party/` 目录，然后到酒馆 → 扩展面板点刷新（或重启酒馆）。

## 使用

1. 到酒馆 **API → Chat Completion → Custom (OpenAI-compatible)**
2. URL 填 `https://ai-gateway.vercel.sh/v1`，模型填如 `deepseek/deepseek-v3.2`、`anthropic/claude-sonnet-4`
3. 打开扩展面板里的「Vercel AI Gateway 助手」抽屉
4. 第 1～3 节选好供应商 / 思考 / 缓存，第 4 节点「写入 包含主体参数」
5. 第 5 节添加 key（单加或批量），点「检查全部余额」，勾上「自动轮询」就可以开撸了

## 一个小限制

扩展是在浏览器里跑的，没法在一次请求"中途"失败时换 key 重试 —— 它只能在每次生成**开始之前**切到下一个活 key。所以建议平时多点几下"检查全部余额"，让死 key 早点进垃圾盒。

## 文件结构

```
vercel-gateway-helper/
├── manifest.json    # 扩展元信息
├── index.js         # 主逻辑
├── style.css        # 样式
├── README.md
└── LICENSE
```

## 许可

MIT
