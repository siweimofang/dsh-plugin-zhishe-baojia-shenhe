# dsh-plugin-zhishe-baojia-shenhe

知设装修报价审核插件 — 装修报价单智能审核与风险识别。

## 功能

- **异常单价识别**: 对标13城52区基准价,自动标记偏离过高的项目(>30% 严重预警)
- **漏项检测**: 检查水电/瓦工/油漆等关键工序是否遗漏
- **单项价格查询**: 查询任意装修项目的合理价格区间
- **地区价格对标**: 结合城市系数+档次系数给出参考价

## 工具

| 工具名 | 说明 |
|--------|------|
| `baojia_shenhe` | 报价审核: 输入报价单文本,返回异常项+漏项+审核报告 |
| `baojia_item_check` | 单项查询: 查询某项目的合理价格区间 |

## 部署平面

- **目标平面**: 会话级工具插件（形态 A）
- **对外发布服务**: 否，仅注册 DSH 工具
- **兼容版本**: `@deepseek-ai/dsh >= 0.1.0-rc.6`

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

```yaml
plugins:
  zhishe-baojia-shenhe:
    city: 沈阳
    tier: 中端
```

## 基准价格库

内置 `lib/benchmark.json`,覆盖6大类30+装修分项,支持13城系数调整。

## License

MIT
