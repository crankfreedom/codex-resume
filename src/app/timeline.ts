import type { AttemptRecord,EventRow } from './contracts.ts';
export const timelineLabels:Record<string,string>={task_created:'创建托管',monitoring_enabled:'开启托管',monitoring_paused:'暂停托管',quota_stop_detected:'真实额度错误',quota_checked:'额度复查',resume_preflight_passed:'恢复条件与最终检查通过',send_intent_persisted:'保存发送意图',resume_submitted:'投递已接收',resume_receipt_matched:'原会话回执匹配',delivery_turn_finished:'投递轮次已结束',goal_observing:'Goal 继续观察',completed:'当前任务完成',suspended:'托管停止',send_uncertain:'发送不确定，只核对',task_archived:'历史归档',task_removed:'移出活动列表',config_revised:'配置修订',authorization_confirmed:'重新确认授权',observe_recovery_detected:'仅观察：恢复条件已确认（应用内）',observe_recovery_ready:'仅观察：允许时段恢复提醒',policy_waiting:'等待时段或队列',task_expired:'托管到期',thread_state_observed:'会话状态变化'};
export function lifecycle(events:EventRow[],attempts:AttemptRecord[]) {
  const rows=events.slice().sort((a,b)=>a.id-b.id);
  return attempts.map(a=>{
    const own=rows.filter(e=>e.details.marker===a.marker);
    const intent=own.find(e=>e.type==='send_intent_persisted');
    const submitted=own.find(e=>e.type==='resume_submitted');
    const receipt=own.find(e=>e.type==='resume_receipt_matched');
    const finish=own.find(e=>e.type==='delivery_turn_finished');
    const stopped=own.find(e=>e.type==='quota_stop_detected');
    const recovery=own.find(e=>e.type==='resume_preflight_passed');
    const duration=(start?:EventRow,end?:EventRow)=>!start?'未知（本页缺少起点）':!end?'进行中／尚无结束证据':end.time<start.time?'未知（时钟回拨）':`${(end.time-start.time)/1000} 秒`;
    return {marker:a.marker,wait:duration(stopped,recovery),receipt:duration(intent,receipt),run:duration(submitted,finish),
      stage:finish?'投递轮次已结束（不等于当前任务完成）':a.slot==='held'?'投递未落定，继续占槽':own.some(e=>e.type==='send_cancelled_before_dispatch')?'派发前已取消':'结束证据未在本页'};
  });
}
