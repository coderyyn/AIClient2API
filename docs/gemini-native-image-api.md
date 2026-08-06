# Gemini 原生 Banana2 图片 API

AIClient2API 可通过 Gemini 原生 `generateContent` 协议调用 `gemini-3.1-flash-image`，支持文生图和多个输入图片的编辑请求。客户端只需替换网关地址和 API Key，不需要 Banana2 专用端点或私有请求字段。

## 端点与鉴权

默认路由：

```text
POST https://YOUR_GATEWAY/v1beta/models/gemini-3.1-flash-image:generateContent
```

指定 Antigravity provider：

```text
POST https://YOUR_GATEWAY/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent
```

以下三种 API Key 传递方式均受支持：

```text
?key=YOUR_API_KEY
x-goog-api-key: YOUR_API_KEY
Authorization: Bearer YOUR_API_KEY
```

服务端或日志可能记录完整 URL，生产调用优先使用 `x-goog-api-key` 或 Bearer 请求头；需要兼容 Gemini SDK 风格时可使用 `generateContent?key=YOUR_API_KEY`。

## 文生图

```bash
curl -sS -X POST \
  "https://YOUR_GATEWAY/v1beta/models/gemini-3.1-flash-image:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "text": "生成一张16:9横向、高细节的蓝色兰花植物学插画，白色背景。"
          }
        ]
      }
    ],
    "generationConfig": {
      "responseModalities": ["IMAGE"],
      "imageConfig": {
        "aspectRatio": "16:9",
        "imageSize": "2K"
      }
    }
  }'
```

改用请求头鉴权时，移除 URL 中的 `?key=YOUR_API_KEY`，并增加：

```text
x-goog-api-key: YOUR_API_KEY
```

## 多图编辑

每个输入图片使用一个独立的 `inlineData` part。`data` 必须是纯 Base64 内容，不要包含 `data:image/png;base64,` 前缀。

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "合并两张图片的内容，背景改成草地。"
        },
        {
          "inlineData": {
            "mimeType": "image/png",
            "data": "FIRST_IMAGE_BASE64"
          }
        },
        {
          "inlineData": {
            "mimeType": "image/jpeg",
            "data": "SECOND_IMAGE_BASE64"
          }
        }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
      "aspectRatio": "16:9",
      "imageSize": "2K"
    }
  }
}
```

多图请求使用与文生图相同的端点，例如：

```text
/v1beta/models/gemini-3.1-flash-image:generateContent?key=YOUR_API_KEY
```

## 响应图片

图片位于 `candidates[].content.parts[].inlineData`：

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "inlineData": {
              "mimeType": "image/png",
              "data": "GENERATED_IMAGE_BASE64"
            }
          }
        ]
      },
      "finishReason": "STOP"
    }
  ]
}
```

客户端应遍历所有 candidate 和 part，并按 `mimeType` 解码 `data`。

## 参数边界

- 图片参数位于 `generationConfig.imageConfig`。
- `aspectRatio` 表示画面比例，例如 `1:1`、`16:9` 或 `9:16`。
- `imageSize` 表示上游分辨率档位，例如 `1K` 或 `2K`；实际可用档位由模型和账号能力决定。
- Gemini 原生端点不使用 OpenAI Images 的 `size` 字段；`size: "1536x1024"` 不属于这里承诺的协议。
- 顶层 `image_config`、`extra_body.google` 以及 OpenAI `/v1/images/*` 参数不属于本接口。
