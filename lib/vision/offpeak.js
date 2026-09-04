/**
 * 峰谷时段判断(北京时间) - v0.5.1 批次二/短板③(闲时调度标记)
 *
 * 口径与后端 app/services/cost_router.py 同源: DeepSeek 高峰=9:00-12:00 + 14:00-18:00
 * (北京时间, 共7h), 其余17h为闲时(含午休12-14)。
 * 依据0905投喂文章⑤「错峰用AI=默认策略非临时优化」; 文章④L5闲时调度层。
 *
 * 用法: 批量场景(多页报价/评测/回归)在返回meta附 offpeak 元数据——只标记不阻塞
 * (验收口径: 高峰不阻塞交互式调用, 闲时批量成本约减半, 以DeepSeek定价页为准)。
 *
 * 实现: 位移时间戳后读UTC分量 → 宿主机时区无关。
 */

const PEAK_WINDOWS = [[9, 12], [14, 18]]; // [起,止) 小时, 北京时间

/** 任意时刻 → 北京时间小时数(含小数); 读UTC分量, 宿主机时区无关 */
export function beijingHour(date = new Date()) {
    // 北京=UTC+8: 时间戳固定+480分钟, 再读UTC分量即北京墙钟(勿掺宿主getTimezoneOffset, 0905实踩)
    const bjMs = date.getTime() + 480 * 60000;
    const bj = new Date(bjMs);
    return bj.getUTCHours() + bj.getUTCMinutes() / 60;
}

/** 当前(或指定时刻)是否DeepSeek高峰时段(北京时间9-12/14-18) */
export function isPeakNow(date = new Date()) {
    const h = beijingHour(date);
    return PEAK_WINDOWS.some(([s, e]) => h >= s && h < e);
}

/** offpeak元数据(附进视觉提取结果meta, 只标记不阻塞) */
export function offpeakMeta(date = new Date()) {
    const peak = isPeakNow(date);
    const bj = new Date(date.getTime() + 480 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const beijing_time = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} `
        + `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
    return {
        peak,
        offpeak: !peak,
        beijing_time,
        peak_windows: '9:00-12:00, 14:00-18:00 (北京时间)',
        note: peak
            ? '当前为高峰时段——批量任务(多页/评测/回归)建议错峰至闲时跑(文章⑤: 错峰=默认策略), 交互式调用不受影响'
            : '当前为闲时时段——批量任务成本约减半(以DeepSeek定价页为准)',
    };
}
