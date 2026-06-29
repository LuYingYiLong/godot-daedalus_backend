# TypeScript 本地 AI Runtime 学习与实现计划

目标不是泛泛地“学 Node.js”，而是学会用 TypeScript 写一个本地 AI Runtime 服务，让 Godot 通过 WebSocket 调用后端，再由后端去调用 DeepSeek 等 LLM 供应商。

## 0. 总体架构

```text
Godot 插件 / 测试脚本
        |
        | WebSocket：你自己定义的协议
        v
TypeScript Node 后端
        |
        | HTTP API：供应商定义的协议
        v
DeepSeek / OpenAI / 本地模型
```

核心原则：

- Godot 不直接保存或使用供应商 API Key。
- Godot 只理解你自己的 WebSocket 协议。
- 后端负责协议校验、路由、上下文读取、调用供应商、返回结果。
- 先做非流式请求，跑通后再做流式输出。

## 1. 当前项目状态

当前项目已经具备：

```text
package.json
tsconfig.json
src/
  main.ts          # WebSocket 服务端
  ping-client.ts   # Node 测试客户端
```

可用命令：

```powershell
npm run dev        # 启动 WebSocket 服务，默认 ws://localhost:8080
npm run ping       # 发送测试 ping，期望收到 pong
npm run typecheck  # TypeScript 类型检查
npm test           # 当前等同于 npm run typecheck
```

Godot 端测试场景：

```text
D:/GodotProjects/example/test.tscn
D:/GodotProjects/example/test.gd
```

## 2. WebSocket 怎么理解

WebSocket 是一根持续打开的双向管道：

- 客户端可以随时发消息给后端。
- 后端也可以随时发消息给客户端。
- 每条消息建议都用 JSON 文本。
- Godot 端必须在 `_process()` 中持续调用 `socket.poll()`。

最小学习顺序：

1. 连接：Godot 连接 `ws://localhost:8080`。
2. 发送：按钮点击时发送 JSON。
3. 接收：后端回 JSON，Godot 解析并打印。
4. 校验：后端用 `zod` 检查消息格式。
5. 路由：根据 `method` 分发到不同功能。

## 3. 第一版协议设计

不要一开始照搬 DeepSeek 的 API。先设计你自己的稳定协议。

### 客户端请求

```ts
type ClientRequest = {
  type: "request";
  id: string;
  method: "ping" | "ai.chat";
  params?: unknown;
};
```

示例：ping

```json
{
  "type": "request",
  "id": "godot-1",
  "method": "ping",
  "params": {}
}
```

示例：AI 对话

```json
{
  "type": "request",
  "id": "godot-2",
  "method": "ai.chat",
  "params": {
    "message": "写一句神秘商人的 NPC 台词"
  }
}
```

### 服务端响应

```ts
type ServerResponse =
  | {
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
```

成功响应：

```json
{
  "type": "response",
  "id": "godot-2",
  "ok": true,
  "result": {
    "text": "旅人，别急着付钱。有些代价不是金币。"
  }
}
```

错误响应：

```json
{
  "type": "response",
  "id": "godot-2",
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "params.message 必须是字符串"
  }
}
```

### 后续流式事件

等非流式跑通后，再加入：

```ts
type ServerEvent = {
  type: "event";
  id: string;
  event: "ai.delta" | "ai.done";
  data?: unknown;
};
```

流式片段示例：

```json
{
  "type": "event",
  "id": "godot-3",
  "event": "ai.delta",
  "data": {
    "text": "旅人，"
  }
}
```

## 4. DeepSeek 供应商适配思路

后端内部新增一个供应商适配层，不让 Godot 直接接触 DeepSeek 格式。

```text
Godot:
  method: "ai.chat"
  params.message: "写一句 NPC 台词"

后端转换为 DeepSeek:
  model: "deepseek-v4-pro"
  messages:
    - role: "system"
      content: "你是一个游戏 NPC 台词助手。"
    - role: "user"
      content: "写一句 NPC 台词"

后端再转换回 Godot:
  result.text: "旅人，前方的雾不是天气。"
```

推荐环境变量：

```powershell
$env:DEEPSEEK_API_KEY = "你的 key"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
```

第一版先做非流式：

```ts
async function chatWithDeepSeek(message: string): Promise<string> {
  // 读取环境变量。
  // 调用 DeepSeek chat completions。
  // 提取回复文本并返回。
}
```

## 5. 推荐项目结构

随着功能增加，把 `src/main.ts` 拆开：

```text
src/
  main.ts
  server/
    websocket-server.ts
    send-json.ts
  protocol/
    schema.ts
    types.ts
  router/
    rpc-router.ts
  providers/
    deepseek-client.ts
    llm-provider.ts
  godot/
    project-context.ts
  prompts/
    godot-assistant.md
```

每层职责：

- `server/`：只管 WebSocket 连接、收包、发包。
- `protocol/`：定义消息类型和 `zod` 校验。
- `router/`：根据 `method` 调用具体功能。
- `providers/`：封装 DeepSeek、OpenAI、本地模型。
- `godot/`：读取 Godot 项目结构、脚本、场景。
- `prompts/`：保存系统提示词和任务模板。

## 6. 第一周路线

### 第 1 天：TS 项目基础

学习：

- `package.json`
- `npm install`
- `npm run`
- `tsconfig.json`
- `type`、`interface`、联合类型

练习：

```powershell
npm run typecheck
npm run dev
npm run ping
```

### 第 2 天：WebSocket ping/pong

目标：

- Godot 点击按钮发送 ping。
- 后端收到后返回 pong。
- Godot 输出面板打印响应。

重点：

- Godot 端持续 `poll()`。
- 后端 `message` 事件收到文本。
- 所有消息都使用 JSON。

### 第 3 天：定义 request/response 协议

把现在的简单 `ping` 升级为：

```json
{
  "type": "request",
  "id": "godot-1",
  "method": "ping",
  "params": {}
}
```

后端统一返回：

```json
{
  "type": "response",
  "id": "godot-1",
  "ok": true,
  "result": {
    "message": "pong"
  }
}
```

### 第 4 天：用 zod 校验协议

学习：

- `z.object`
- `z.literal`
- `z.union`
- `safeParse`

目标：

- 格式错误时不让后端崩溃。
- 返回结构化错误。

### 第 5 天：加入 ai.chat 方法

先不接 DeepSeek，写一个假回复：

```ts
if (request.method === "ai.chat") {
  return "这是一个假 AI 回复";
}
```

目标是理解路由，而不是同时处理网络、鉴权和供应商错误。

### 第 6 天：接 DeepSeek 非流式请求

学习：

- `fetch`
- `async/await`
- 环境变量
- try/catch

目标：

- Godot 发一句话。
- 后端调用 DeepSeek。
- Godot 收到完整文本。

### 第 7 天：整理结构

把代码拆成：

```text
protocol/
router/
providers/
server/
```

保持每个文件职责单一。

## 7. TypeScript 新手学习重点

优先学这些：

- `string`、`number`、`boolean`
- `unknown`：外部输入先用它表示
- `type`：定义数据结构
- 联合类型：`A | B`
- 字面量类型：`"ping"`、`"ai.chat"`
- `async/await`
- `Promise<T>`
- `import/export`
- `zod` 的运行时校验

暂时不用急：

- 装饰器
- 高级泛型
- NestJS
- ORM
- Docker
- 微服务
- 前端框架

Java 背景可以这样类比：

```text
interface ≈ DTO / 接口
type ≈ 更灵活的类型别名
class ≈ Java class，但 TS 里别急着滥用
unknown ≈ 安全版 Object
Promise<T> ≈ Future<T>
async/await ≈ 写起来像同步的异步
```

## 8. 里程碑

### v0.1：本地 WebSocket 服务

- `npm run dev` 启动服务。
- `npm run ping` 收到 pong。
- Godot 按钮能 ping/pong。

### v0.2：统一 RPC 协议

- 所有请求都有 `id`、`method`、`params`。
- 所有响应都有 `ok`、`result` 或 `error`。
- 错误不会让服务崩溃。

### v0.3：接 DeepSeek

- 后端读取 `DEEPSEEK_API_KEY`。
- 支持 `method: "ai.chat"`。
- Godot 能显示完整 AI 回复。

### v0.4：读取 Godot 项目上下文

- 读取 `project.godot`。
- 扫描 `addons/`、`scripts/`、`*.tscn`。
- 把项目摘要传给 AI。

### v0.5：流式输出

- 后端把供应商流式结果转成 WebSocket `event`。
- Godot 聊天 UI 逐字显示。

### v0.6：MCP 和技能系统

- 接入 MCP client。
- 增加 `skill_registry`。
- 让 AI 能调用工具读取项目。

## 9. 每次写代码前的自检

问自己：

- 这条消息是 Godot 协议，还是供应商协议？
- 外部输入有没有经过 `zod` 校验？
- 失败时有没有返回 `{ ok: false, error }`？
- API Key 有没有只留在后端？
- 这一步是不是比当前学习阶段太超前？

先把小闭环跑通，再扩展。最稳的路径是：

```text
ping -> request/response -> zod -> fake ai.chat -> DeepSeek -> streaming -> Godot UI
```
