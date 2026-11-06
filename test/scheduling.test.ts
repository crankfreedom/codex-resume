import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorService } from '../src/app/service.ts';
import { exampleQuota } from '../src/scenarios.ts';
import { defaultTaskConfig, timePolicy, validateEditable } from '../src/app/task-policy.ts';
import type { ThreadView, CurrentGoal } from '../src/domain.ts';

class Fleet {
  caller=randomUUID(); ids=[randomUUID(),randomUUID(),randomUUID()]; used=100;
  views=new Map<string,ThreadView>(this.ids.map(id=>[id,{thread:{id,status:{type:'idle'}},turns:[{id:'blocked-'+id,status:'failed',error:{code:'UsageLimitExceeded'}}]} as ThreadView]));
  goals=new Map<string,CurrentGoal>(); sent:string[]=[]; hidden=false; uncertain=false;
  afterPreflight?:()=>Promise<void>;reconnected=false;beforeSend?:()=>Promise<void>; onIntent?:()=>void;
  async quota(){return exampleQuota(this.used,Date.now());}
  async call<T>(){return {threads:this.ids.map((id,i)=>({id,title:'队列任务'+i,kind:'codex',hostId:'local',status:'idle'}))} as T;}
  async readThread(id:string){const view=structuredClone(this.views.get(id)!);if(this.hidden)view.turns=view.turns.filter(t=>!t.id.startsWith('own-'));return view;}
  async send(id:string,prompt:string,beforeDispatch?:(reconnected?:boolean)=>void|Promise<void>,beforeWrite?:()=>void){
    this.onIntent?.();await this.beforeSend?.();await beforeDispatch?.(this.reconnected);await this.afterPreflight?.();beforeWrite?.();this.sent.push(id);
    const view=this.views.get(id)!;view.thread.status.type='active';view.turns.unshift({id:'own-'+id,status:'inProgress',items:[{type:'userMessage',text:prompt}]});
    if(this.uncertain)throw new Error('模拟响应丢失');
  }
  close(){}
}
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'resume-queue-'));const desktop=new Fleet();let now=new Date(2026,10,6,12,0).getTime();
  let service=new MonitorService(dir,()=>desktop,()=>now,id=>desktop.goals.get(id) ?? null);
  service.db.setSettings({...service.db.settings(),callerThreadId:desktop.caller,queue:{enabled:true,limit:1}});await service.tick(true);
  return {desktop,get service(){return service;},advance:(ms:number)=>{now+=ms;},now:()=>now,
    add:async(i:number,config={})=>{await service.command({type:'add',targetThreadId:desktop.ids[i]!,prompt:'继续原授权任务',maxResumes:3,config});return service.db.tasks().find(t=>t.targetThreadId===desktop.ids[i])!;},
    restart:async()=>{await service.stop();service=new MonitorService(dir,()=>desktop,()=>now,id=>desktop.goals.get(id) ?? null);},
    close:async()=>{await service.stop();rmSync(dir,{recursive:true,force:true});}};
}

test('时段边界与跨午夜：开始含结束不含、截止绝对时间、时钟回拨与全天显式',()=>{
  const c=defaultTaskConfig();c.window={allDay:false,start:22*60,end:6*60};
  const at=(h:number,m=0)=>new Date(2026,10,6,h,m).getTime();
  assert.equal(timePolicy(c,at(22)),null);assert.equal(timePolicy(c,at(5,59)),null);
  assert.equal(timePolicy(c,at(6)),'outside_window');assert.equal(timePolicy(c,at(21,59)),'outside_window');
  c.expiresAt=at(23);assert.equal(timePolicy(c,at(23)),'expired');assert.equal(timePolicy(c,at(22)),null);
  assert.throws(()=>validateEditable({...c,prompt:'继续',maxResumes:3,window:{allDay:false,start:0,end:0}}),/配置无效/);
});

test('稳定优先级与同级排序：阻断目标跳过；暂停不释放已匹配运行轮次；完结后才放行下一目标',async()=>{
  const f=await fixture();try{
    const low=await f.add(0,{priority:2});const high=await f.add(1,{priority:0});await f.add(2,{priority:0});
    await f.service.command({type:'reorder',id:high.id,direction:'down'});
    const first=f.service.db.tasks()[0]!;assert.equal(first.targetThreadId,f.desktop.ids[2]);
    const original=f.service.db.jobs()[0]!.job;f.service.db.journal(first.id).save(original);assert.equal(f.service.db.tasks()[0]!.id,first.id);
    // 最高顺序普通失败不能阻塞后面的额度任务。
    f.desktop.views.get(first.targetThreadId)!.turns[0]!.error={code:'ordinary_failure'};
    await f.service.tick(true);f.desktop.used=0;
    f.desktop.onIntent=()=>{assert.equal(f.service.db.slots(),1);assert.equal(f.service.db.db.prepare("SELECT revision FROM attempts WHERE slot='held'").get()!.revision,1);};
    await f.service.tick(true);assert.deepEqual(f.desktop.sent,[high.targetThreadId]);assert.equal(f.service.db.slots(),1);
    await f.service.tick(true);assert.equal(f.service.db.tasks().find(t=>t.id===high.id)!.sentTurnId,'own-'+high.targetThreadId);
    await f.service.command({type:'toggle',id:high.id,enabled:false});await f.service.tick(true);
    assert.equal(f.service.db.slots(),1);assert.equal(f.desktop.sent.length,1);
    await assert.rejects(f.service.command({type:'remove',id:high.id}),/未落定/);
    await assert.rejects(f.service.command({type:'edit',id:high.id,revision:1,value:{...high.config,prompt:'编辑',maxResumes:3}}),/未落定/);
    const view=f.desktop.views.get(high.targetThreadId)!;view.turns[0]!.status='completed';view.thread.status.type='idle';
    await f.service.tick(true);assert.equal(f.desktop.sent.length,2);assert.equal(f.desktop.sent[1],low.targetThreadId);assert.equal(f.service.db.slots(),1);
  }finally{await f.close();}
});

test('发送不确定跨重启与到期保守占槽，不能编辑删除重建，最终读到对应轮次结束才释放',async()=>{
  const f=await fixture();try{
    const first=await f.add(0,{priority:0,expiresAt:f.now()+30000});await f.add(1);
    await f.service.tick(true);f.desktop.used=0;f.desktop.uncertain=true;f.desktop.hidden=true;await f.service.tick(true);
    assert.equal(f.desktop.sent.length,1);assert.equal(f.service.db.slots(),1);
    await f.service.command({type:'toggle',id:first.id,enabled:false});f.advance(60000);await f.restart();await f.service.tick(true);
    assert.equal(f.desktop.sent.length,1);assert.equal(f.service.db.slots(),1);
    await assert.rejects(f.add(0),/已在托管/);
    await assert.rejects(f.service.command({type:'toggle',id:first.id,enabled:true,confirmedRevision:1}),/未落定/);
    f.desktop.hidden=false;await f.service.command({type:'reconcile',id:first.id});assert.equal(f.service.db.slots(),1);
    f.desktop.views.get(first.targetThreadId)!.turns[0]!.status='completed';f.desktop.views.get(first.targetThreadId)!.thread.status.type='idle';f.desktop.uncertain=false;
    await f.service.tick(true);assert.equal(f.desktop.sent.length,2);assert.equal(f.service.db.slots(),1);
  }finally{await f.close();}
});

test('派发前过期或暂停回滚槽位与次数，时段外无发送意图，休眠补查后重新读额度',async()=>{
  for(const action of ['expire','pause'] as const){const f=await fixture();try{
    const task=await f.add(0,{expiresAt:f.now()+5000});await f.service.tick(true);f.desktop.used=0;
    f.desktop.beforeSend=async()=>{if(action==='expire')f.advance(5000);else await f.service.command({type:'toggle',id:task.id,enabled:false});};
    await f.service.tick(true);assert.equal(f.desktop.sent.length,0);assert.equal(f.service.db.slots(),0);assert.equal(f.service.db.tasks()[0]!.resumeCount,0);
  }finally{await f.close();}}
  const f=await fixture();try{
    await f.add(0,{window:{allDay:false,start:13*60,end:14*60}});await f.service.tick(true);f.desktop.used=0;await f.service.tick(true);
    assert.equal(f.service.db.slots(),0);assert.equal(f.desktop.sent.length,0);assert.equal(f.service.db.tasks()[0]!.reason,'outside_window');
    f.advance(3600000);await f.service.tick();assert.equal(f.desktop.sent.length,1);
  }finally{await f.close();}
});

test('时段外观察仅应用内提醒，允许时段重新核验后通知，到期不再提醒；队列降限不抢占',async()=>{
  const f=await fixture();try{
    await f.add(0,{mode:'observe',window:{allDay:false,start:13*60,end:14*60}});await f.service.tick(true);f.desktop.used=0;await f.service.tick(true);
    assert.equal(f.service.db.events().filter(e=>e.type==='observe_recovery_detected').length,1);
    assert.equal(f.service.db.events().filter(e=>e.type==='observe_recovery_ready').length,0);
    assert.equal(f.service.db.slots(),0);f.advance(3600000);await f.service.tick();
    assert.equal(f.service.db.events().filter(e=>e.type==='observe_recovery_ready').length,1);assert.equal(f.desktop.sent.length,0);
    await f.add(1);await f.add(2);await f.service.command({type:'settings',value:{...f.service.db.settings(),queue:{enabled:true,limit:2}}});await f.service.tick(true);
    assert.equal(f.service.db.slots(),2);await f.service.command({type:'settings',value:{...f.service.db.settings(),queue:{enabled:true,limit:1}}});
    await f.service.tick(true);assert.equal(f.service.db.slots(),2);assert.equal(f.desktop.sent.length,2);
  }finally{await f.close();}
});

test('重连期间额度、账号或停止轮次变化，最终复查取消意图且不发送；暂停阻止异步重新授权',async()=>{
  for (const change of ['quota','turn'] as const) {
    const f=await fixture();try{
      await f.add(0);await f.service.tick(true);f.desktop.used=0;f.desktop.reconnected=true;
      f.desktop.beforeSend=async()=>{if(change==='quota')f.desktop.used=100;else f.desktop.views.get(f.desktop.ids[0]!)!.turns.unshift({id:'manual',status:'inProgress'});};
      await f.service.tick(true);assert.equal(f.desktop.sent.length,0);assert.equal(f.service.db.slots(),0);assert.equal(f.service.db.tasks()[0]!.resumeCount,0);
    }finally{await f.close();}
  }
  const f=await fixture();try{
    const task=await f.add(0);await f.service.command({type:'toggle',id:task.id,enabled:false});
    const original=f.desktop.readThread.bind(f.desktop);let release!:()=>void;
    f.desktop.readThread=async id=>{await new Promise<void>(r=>release=r);return original(id);};
    const enabling=f.service.command({type:'toggle',id:task.id,enabled:true});
    await f.service.command({type:'toggle',id:task.id,enabled:false});release();
    await assert.rejects(enabling,/状态已变化/);assert.equal(f.service.db.enabled(task.id),false);
  }finally{await f.close();}
});

test('已提交轮次到期或Goal暂停继续占槽；只读自检即使看到轮次结束也不推进槽位或任务',async()=>{
  const f=await fixture();try{
    const goal={id:'goal-held',status:'active' as const};f.desktop.goals.set(f.desktop.ids[0]!,goal);
    const first=await f.add(0,{expiresAt:f.now()+5000});await f.add(1);
    await f.service.tick(true);f.desktop.used=0;await f.service.tick(true);assert.equal(f.service.db.slots(),1);
    f.desktop.goals.set(first.targetThreadId,{id:goal.id,status:'paused'});f.advance(5000);await f.service.tick(true);
    assert.equal(f.service.db.slots(),1);assert.equal(f.desktop.sent.length,1);
    assert.equal(f.service.db.tasks().find(t=>t.id===first.id)!.enabled,false);
    const view=f.desktop.views.get(first.targetThreadId)!;view.turns[0]!.status='completed';view.thread.status.type='idle';
    const before=f.service.db.jobs();await f.service.command({type:'selfCheck'});
    assert.equal(f.service.db.slots(),1);assert.deepEqual(f.service.db.jobs(),before);
    await f.service.tick(true);assert.equal(f.desktop.sent.length,2);assert.equal(f.service.db.slots(),1);
  }finally{await f.close();}
});

test('异步派发复查完成后暂停，在实际写入之前仍被同步门禁阻止',async()=>{
  const f=await fixture();try{
    const task=await f.add(0);await f.service.tick(true);f.desktop.used=0;
    f.desktop.afterPreflight=async()=>{await f.service.command({type:'toggle',id:task.id,enabled:false});};
    await f.service.tick(true);assert.equal(f.desktop.sent.length,0);assert.equal(f.service.db.slots(),0);assert.equal(f.service.db.tasks()[0]!.resumeCount,0);
  }finally{await f.close();}
});

test('确定派发前取消后重新授权使用新标记，旧尝试保留且新投递重新占槽',async()=>{
  const f=await fixture();try{
    const task=await f.add(0);await f.service.tick(true);f.desktop.used=0;
    f.desktop.afterPreflight=async()=>{await f.service.command({type:'toggle',id:task.id,enabled:false});};
    await f.service.tick(true);assert.equal(f.service.db.slots(),0);const oldMarker=f.service.db.jobs()[0]!.job.marker;
    f.desktop.afterPreflight=undefined;
    await f.service.command({type:'edit',id:task.id,revision:1,value:{...task.config,prompt:'确认后继续',maxResumes:3}});
    await f.service.command({type:'toggle',id:task.id,enabled:true,confirmedRevision:2});
    await f.service.tick(true);assert.equal(f.desktop.sent.length,1);assert.equal(f.service.db.slots(),1);
    const attempts=f.service.db.query({type:'timeline',taskId:task.id}).attempts!;
    assert.equal(attempts.length,2);assert.equal(attempts.find(a=>a.marker===oldMarker)!.slot,'released');
    assert.notEqual(f.service.db.jobs()[0]!.job.marker,oldMarker);assert.equal(f.service.db.tasks()[0]!.resumeCount,1);
  }finally{await f.close();}
});
