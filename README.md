# dsh-plugin-zhishe-baojia-shenhe

知设装修报价审核插件 — 装修报价单 + 装修合同智能审核与风险识别，支持视觉OCR截图输入，内置签约避坑提示。

## 功能

- **视觉OCR输入** (v0.3.0): 上传报价单截图/照片，自动提取文本后审核，成本 < 0.01元/次
- **异常单价识别**: 对标13城52区基准价，自动标记偏离过高的项目(>30% 严重预警)
- **签约避坑提示** (v0.4.0): 基于 20 年实战避坑库（内嵌精简版 161 条），按审核结果自动挂载避坑建议，报告新增「避坑提示」章节
- **合同审核** (v0.4.0): 新工具 `hetong_shenhe`——合同文本/脱敏截图输入，19 条条款风险规则（含法定底线）+ 避坑提示，PII 解析前自动打码
- **漏项检测**: 检查水电/瓦工/油漆等关键工序是否遗漏
- **单项价格查询**: 查询任意装修项目的合理价格区间
- **地区价格对标**: 结合城市系数+档次系数给出参考价

## 工具

| 工具名 | 说明 |
|--------|------|
| `baojia_shenhe` | 报价审核: 支持文本或图片输入，返回异常项+漏项+审核报告 |
| `baojia_image_audit` | 图片审核: 上传一张或多张报价单截图，自动OCR+审核 |
| `baojia_item_check` | 单项查询: 查询某项目的合理价格区间 |
| `hetong_shenhe` | 合同审核 (v0.4.0): 合同文本或脱敏截图(1-6张)输入，提取条款 → 19 条风险规则审核 → 签约避坑提示。**红线：合同原件属红档禁止上传，只传涂掉姓名/电话/证件号的脱敏件** |

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

## 合同审核 (v0.4.0)

`hetong_shenhe` 工具链：视觉 JSON 提取（严格 schema，不确定填 null 禁止编造）→ 多页合并 → 19 条规则审核 → 按风险主题挂载避坑提示。JSON 解析失败自动降级文本启发式提取。

**19 条规则与法条锚点**：

- 法定底线：装修保修 ≥2 年 / 防水保修 5 年（住建部令第 110 号第三十二条）；定金 ≤ 主合同标的额 20%（《民法典》第586条）；「最终解释权归乙方」「概不负责」类格式条款无效（《民法典》第497条 + 《消费者权益保护法》第26条）；保修自竣工验收合格之日起算（《建设工程质量管理条例》第40条）
- 行业惯例：首付 ≤50% / 尾款 ≥5% / 付款合计 100% / 付款挂工程节点 / 增项封顶 5%~8% / 日违约金 0.5‰~1‰ / 材料锁品牌型号（「同档替换」=高危）/ 争议解决方式
- 隐私护栏：PII（手机号/身份证）在解析前自动打码；检出未脱净联系方式即红档警告

```javascript
hetong_shenhe({
  contract_text: "甲方：张**\n合同总价：120000元\n付款方式：开工前支付30%..."
})
// 或脱敏截图（1-6 张）
hetong_shenhe({ contract_images: ["contract_p1.png", "contract_p2.png"] })
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

- **v0.4.1** (2026-09-04): 三个修复——①图片路径 PII 红线漏报：OCR schema 增 `contact_info` 转写字段（仅用于隐私检测，提取后即删，不入报告），手机号现可被识别打码并触发 PII 旗标；②违约金 ‰ 换算不稳定：prompt 规则 13 显式换算公式（千分之N→N/10、万分之N→N/100、百分之N直读），消除同图两次提取结果漂移；③避坑库补合同侧主题 4 条（161→165：材料品牌确认/乳胶漆保修等）
- **v0.4.0** (2026-09-03): Step1 避坑接线（内嵌 161 条精简避坑库 + 标题共现加权匹配，报告新增「避坑提示」章节）+ Step2 合同审核（第四工具 `hetong_shenhe`：视觉条款提取/多页合并/PII 解析前打码/19 条风险规则含法条锚点/避坑提示挂载）
- **v0.3.1** (2026-09-03): 视觉提取器重构（`visionExtractText` 单点复用，`thinking:disabled` 铁律收敛，修复 DS 默认开思考烧光 max_tokens 返空正文问题）
- **v0.3.0** (2026-08-21): 接入 rc.8 视觉能力，新增图片OCR+审核
- **v0.2.0** (2026-08-21): 基准价格库 + 异常引擎 + 漏项检测
- **v0.1.0** (2026-08-21): 核心逻辑拆分至独立模块

## License

MIT
