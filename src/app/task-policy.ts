import type { EditableConfig, TaskConfig } from './contracts.ts';
export function defaultTaskConfig(queueOrder=0):TaskConfig {
  return {revision:1,mode:'auto',priority:1,queueOrder,expiresAt:null,window:{allDay:true,start:0,end:0}};
}
export function validateEditable(value:EditableConfig,used=0):EditableConfig {
  if (!value || typeof value.prompt!=='string' || !value.prompt.trim() || value.prompt.length>10000
    || !Number.isInteger(value.maxResumes) || value.maxResumes<1 || value.maxResumes>20 || value.maxResumes<used
    || !['auto','observe'].includes(value.mode) || ![0,1,2].includes(value.priority)
    || (value.expiresAt!==null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt<0))
    || !value.window || typeof value.window.allDay!=='boolean'
    || !Number.isInteger(value.window.start) || value.window.start<0 || value.window.start>=1440
    || !Number.isInteger(value.window.end) || value.window.end<0 || value.window.end>=1440
    || (!value.window.allDay && value.window.start===value.window.end)) throw new Error('托管配置无效：提示词、累计上限、模式或时段不合法');
  return {...value,prompt:value.prompt.trim()};
}
export function timePolicy(config:TaskConfig,now:number):'expired'|'outside_window'|null {
  if (config.expiresAt!==null && now>=config.expiresAt) return 'expired';
  if (config.window.allDay) return null;
  const date=new Date(now); const minute=date.getHours()*60+date.getMinutes();
  const {start,end}=config.window;
  const allowed=start<end ? minute>=start && minute<end : minute>=start || minute<end;
  return allowed?null:'outside_window';
}
