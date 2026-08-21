# dsh-plugin-zhishe-baojia-shenhe

知设装修报价审核插件 — 装修报价单智能审核与风险识别，支持视觉OCR截图输入。

## 功能

- **视觉OCR输入** (v0.3.0): 上传报价单截图/照片，自动提取文本后审核，成本 < 0.01元/次
- **异常单价识别**: 对标13城52区基准价，自动标记偏离过高的项目(>30% 严重预警)
- **漏项检测**: 检查水电/瓦工/油漆等关键工序是否遗漏
- **单项价格查询**: 查询任意装修项目的合理价格区间
- **地区价格对标**: 结合城市系数+档次系数给出参考价

## 工具

| 工具名 | 说明 |
|--------|------|
| `baojia_shenhe` | 报价审核: 支持文本或图片输入，返回异常项+漏项+审核报告 |
| `baojia_image_audit` | 图片审核: 上传一张或多张报价单截图，自动OCR+审核 |
| `baojia_item_check` | 单项查询: 查询某项目的合理价格区间 |

## 视觉能力

基于 DeepSeek V4-Flash-Vision-Exp，支持三种图片传入:

1. **base64 data URI**: `data:image/png;base64,...`
2. **图片URL**: `https://example.com/quote.png`
3. **本地文件路径**: `/path/to/quote.jpg`

需要配置环境变量 `DEEPSEEK_API_KEY`。未配置时优雅降级，提示使用文本输入。

```bash
# 设置 API Key (Windows)
set DEEPSEEK_API_KEY=sk-xxx

# 设置 API Key (Linux/Mac)
export DEEPSEEK_API_KEY=sk-xxx
```

## 部署平面

- **目标平面**: 会话级工具插件（形态 A）
- **对外发布服务**: 否，仅注册 DSH 工具
- **兼容版本**: `@deepseek-ai/dsh >= 0.1.0-rc.8`

## 安装

```bash
cd dsh-plugin-zhishe-baojia-shenhe
npm install
```

注册到 profile：

```bash
dsh plugin --profile <profile> add ./dsh-plugin-zhishe-baojia-shenhe
```

## 使用示例

### 文本输入
```javascript
baojia_shenhe({
  quote_text: "水电改造 55元/㎡ 90㎡ 4950元\n防水工程 75元/㎡ 30㎡ 2250元",
  city: "沈阳",
  tier: "中端"
})
```

### 图片输入
```javascript
baojia_shenhe({
  quote_image: "/path/to/quote_screenshot.png",
  city: "北京",
  tier: "高端"
})
```

### 多页图片审核
```javascript
baojia_image_audit({
  images: ["page1.png", "page2.jpg", "page3.png"],
  city: "上海",
  tier: "豪华"
})
```

## 基准价格库

内置 `lib/benchmark.json`，覆盖6大类30+装修分项，支持13城系数调整。

## 版本历史

- **v0.3.0** (2026-08-21): 接入 rc.8 视觉能力，新增图片OCR+审核
- **v0.2.0** (2026-08-21): 基准价格库 + 异常引擎 + 漏项检测
- **v0.1.0** (2026-08-21): 核心逻辑拆分至独立模块

## License

MIT
