import { fingerprint, quotaGate, stoppedForQuota } from '../domain.ts';
import type { Job, Quota, ThreadView } from '../domain.ts';
import type { CheckItem, CheckStatus } from './contracts.ts';

export function check(key: string, label: string, status: CheckStatus, reason: string, advice: string, checkedAt: number | null): CheckItem {
  return { key, label, status, reason, advice, checkedAt };
}
// 与后台共用领域判定，读到通过只代表此时间点，不能充当投递授权。
export function taskChecks(job: Job, enabled: boolean, view: ThreadView, quota: Quota, now: number): CheckItem[] {
  const gate = quotaGate(quota, job.bucketId, now);
  let matches = false; try { matches = fingerprint(quota) === job.accountFingerprint; } catch { /* 身份缺失 */ }
  const latest = view.turns[0];
  const goalOk = (view.goal?.id ?? null) === job.goalId && (!view.goal || ['active', 'usage_limited'].includes(view.goal.status));
  const item = (key: string, label: string, ok: boolean, reason: string, advice: string) => check(key,label,ok ? 'pass' : 'blocked',reason,advice,now);
  return [
    check('quota','额度完整性与双窗口',gate.reason === 'quota_unknown' ? 'unknown' : gate.available ? 'pass' : 'blocked',
      gate.reason + '；' + gate.windows.map((w,i)=>`${i===0?'5小时':'每周'}已用 ${w?.usedPercent ?? '未知'}%`).join('；'),'等待下一次服务端额度复查',now),
    item('account','账号匹配',matches,matches?'与原授权账号一致':'身份缺失或账号已变化','返回原账号并重新核验'),
    item('target','目标身份',view.thread.id === job.targetThreadId,view.thread.id === job.targetThreadId ? '原目标一致' : '目标已变化','核对原会话'),
    item('quotaError','最新轮次真实额度错误',stoppedForQuota(view),latest ? `${latest.id} / ${latest.status}` : '没有轮次证据','只有最新失败轮次的额度错误可续跑'),
    check('stoppedTurn','原停止轮次',job.blockedTurnId ? (latest?.id===job.blockedTurnId?'pass':'blocked') : 'unchecked',job.blockedTurnId ?? '后台尚未锚定停止轮次','人工恢复后不会沿用旧停止轮次',now),
    item('activity','运行与审批',view.thread.status.type !== 'active' && !view.thread.status.activeFlags?.length,view.thread.status.type + ' / ' + (view.thread.status.activeFlags?.join(',') || '无活动标志'),'运行、输入或审批期间不会新增投递'),
    check('goal','当前 Goal',goalOk?'pass':'blocked',view.goal ? `${view.goal.id} / ${view.goal.status}` : '无当前 Goal','Goal 身份变化、暂停、受阻或预算限制需人工处理',now),
    item('authorization','托管授权',enabled,enabled?'托管已开启':'托管已暂停','暂停配置修改后需重新确认授权'),
    item('count','累计续跑次数',job.resumeCount < (job.maxResumes ?? 1),`${job.resumeCount} / ${job.maxResumes ?? 1}`,'上限不按轮次或重启重置'),
    check('next','下次检查','na',String(job.nextCheckAt),'预计恢复时间不能作为恢复证据',now),
  ];
}
