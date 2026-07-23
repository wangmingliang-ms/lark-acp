# Card 模式图文混排 (inline images in conversation cards)

## 目标

Agent 回复里的图片,作为 `img` 元素**内嵌进流式 interactive card**,与文字按原始顺序混排;取代现在"图片作为独立 message 发送"的做法。保留卡片的流式更新 / 取消按钮 / profile footer 全部能力。

## 飞书能力(已实证)

- v2 卡片支持 `{ tag: "img", img_key: "<key>", alt: {...} }` 元素,与 `markdown` 元素在 `elements` 数组同级混排。
- 图片先 `im.image.create` 上传拿 key(已有 `LarkHttpClient.uploadImage`);消息里字段叫 `image_key`,卡片元素里叫 `img_key`,同一个 key 值。

## 两类来源与定位

1. **ACP `image` 块**(截图/生成图):流式中作为离散事件到达 → 到达时**立即插入 image 时间线条目**,位置天然保留。
2. **markdown `![](file://|https://)`**:嵌在文字里 → 在 **turn finalize** 时把 text 条目按图片位置拆成 [text, image, text]。

## 核心设计:时间线新增 image 条目 + 异步上传 + patch

统一在 finalize 上传(离散 ACP 块在流式期先插占位条目锁定位置),上传完再 patch key 触发重渲。

### 数据模型改动(编译强制点)

- `src/conversation/topic-conversation.ts:53` `TimelineEntry` union 加:
  `{ readonly kind: "image"; readonly imageId: string; readonly status: "uploading"|"ready"|"failed"; readonly imgKey?: string; readonly alt?: string }`
- `src/presenter/conversation-card-view.ts:39` `ConversationTimelineEntry` 加同构 image;并把 `ArchivedTimelineEntry`(:52)放开 image。
- `src/conversation/conversation-card-budget.ts:18` `entryBytes`:image → 固定小值(alt 字节,图片本身不占 markdown 字节预算)。
- `src/conversation/conversation-card-view-mapper.ts:52` `entries()`:storage image → view image。
- `src/presenter/lark-presenter.ts:309` `semanticEntryToCardElement`:
  - `status==="ready"` → `{ tag:"img", img_key, alt:{tag:"plain_text",content:alt??""} }`
  - `uploading` → 文字占位 `{ tag:"markdown", content:"🖼️ 图片上传中…" }`
  - `failed` → 文字占位(远程给链接,本地给 `[图片发送失败]`,不泄漏路径)

### append / mutate API

- `topic-conversation.ts` `ResponseCard`:image 不参与 text/tool 合并,直接 push;新增 `updateImage(imageId, patch)`(仿 `updateTool`)。
- `TopicConversation` + `ResponseLifecycle` + session:加 `appendImage` / `updateImage` 透传;插入前走 `rotateBeforeElement`(占 1 元素预算)。

### 上传编排(chat-runtime,src/gateway/chat-runtime.ts)

- 流式:ACP `image` 块到达 → `appendImage(uploading)` 记录位置 + 收集待传。
- finalize(seal 后、flush 前):
  1. 从 finalized text 抽 markdown 图片,把对应 text 条目拆成 text+image(image=uploading)。
  2. 并发上传所有 image 条目(`resolveImageBytes` → `uploadImage`),`p-limit` 限流。
  3. 每个结果 `updateImage(ready, imgKey)` 或 `updateImage(failed)`(store transaction 触发重渲)。
  4. `flushPresentation()` 落地。
- 删除旧的 `deliverOutboundImages` 独立消息路径(失败降级改为 inline 文字占位)。

### 静默点复查(不编译报错但要处理)

- `card-text-budget.ts:14` divider:image 前是否加 `hr`(倾向:与 text 同规则)。
- view-mapper `summary()`:纯 image 卡片 summary 兜底为 "[图片]"。
- lark-presenter 的 activity/latestEntryText 扫描:image 忽略即可。
- lark-presenter 运行时 view/entry 校验器(:697-811):放开 image kind。

## 关键文件

| 文件                                                | 改动                                                   |
| --------------------------------------------------- | ------------------------------------------------------ |
| `src/conversation/topic-conversation.ts`            | TimelineEntry 加 image;ResponseCard append/updateImage |
| `src/presenter/conversation-card-view.ts`           | view 层 image 类型                                     |
| `src/conversation/conversation-card-view-mapper.ts` | mapper + summary 兜底                                  |
| `src/conversation/conversation-card-budget.ts`      | entryBytes image                                       |
| `src/presenter/lark-presenter.ts`                   | 卡片 img 元素渲染 + 校验器                             |
| `src/conversation/topic-conversation-session.ts`    | appendImage/updateImage + finalize 拆分                |
| `src/gateway/chat-runtime.ts`                       | 上传编排,替换 deliverOutboundImages                    |
| `src/lark/lark-http.ts`                             | uploadImage 已有(复用)                                 |

## 测试

- 单元:mapper image、entryBytes image、card 元素渲染(ready/uploading/failed)、text 条目按 markdown 图片拆分、budget 轮转。
- 集成 `tests/`:模拟一个 turn(text + ACP image 块 + markdown 图),断言最终卡片 elements 里 img 与 markdown 按序混排;上传失败 → inline 文字占位。
- 全量 vitest + tsc。

## 验证

- feature branch 上 build + 真机:让 agent 发图文混排,确认图片**内嵌在卡片里**、且在 thread 内、卡片正常 close。
