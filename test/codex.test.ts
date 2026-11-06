
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DesktopClient } from '../src/desktop.ts';
import { discoverCaller, threadIdPattern } from '../src/app/bootstrap.ts';
import { FileJournal } from '../src/store.ts';

interface ConnectionOptions {
    callerThreadId?: string;
    pipe?: string;
}

function checkId(id: string) {
    if (!threadIdPattern.test(id)) throw new Error('会话 ID 必须是 UUID；请使用 getTasks 返回的 id，不是托管任务 ID');
}

async function withClient<T>(options: ConnectionOptions, action: (client: DesktopClient) => Promise<T>): Promise<T> {
    const caller = options.callerThreadId ?? discoverCaller();
    checkId(caller);
    const client = new DesktopClient(caller, options.pipe);
    try { return await action(client); }
    finally { client.close(); }
}

// 查询 Codex 账户额度。额度属于账户，无需传任务；保留服务端原始字段和 null。
export function checkCodex(options: ConnectionOptions = {}) {
    return withClient(options, client => client.quota());
}

// 获取最近 50 个非置顶任务及所有置顶任务，保留 pinnedThreads / threads 等原始字段。
export async function getTasks(options: ConnectionOptions = {}) {
    return withClient(options, client => client.call<{
        pinnedThreads?: unknown[];
        threads: unknown[];
        [key: string]: unknown;
    }>('list_threads', { limit: 50 }));
}

// 根据会话 ID 获取详情：thread、最近 10 轮 turns、错误和输出（每项最多 2000 字符）。
export async function getTaskById(taskId: string, options: ConnectionOptions = {}) {
    checkId(taskId);
    return withClient(options, client => client.readThread(taskId));
}

// 用新提示词继续已有的空闲本机会话；只发送一次，返回原始提交回执，不等待任务完成。
// 调用此方法即显式发送；自动化 test 和下方只读命令均不会调用它。
export function launchTask(taskId: string, prompt: string, options: ConnectionOptions = {}) {
    checkId(taskId);
    if (!prompt.trim()) throw new Error('续跑提示词不能为空');
    return withClient(options, async client => {
        if (taskId === client.callerThreadId) throw new Error('请选择其他会话，不能向调用会话自身发送');
        // 与 CLI / 桌面共用目标锁，避免和现有托管同时投递。
        const journal = new FileJournal(resolve(import.meta.dirname, '../var', `manual-${randomUUID()}.json`), false);
        const release = journal.lock(taskId);
        let dispatched = false;
        try {
            const view = await client.readThread(taskId);
            if (view.thread.status.type !== 'idle') throw new Error(`目标会话当前不是空闲状态：${view.thread.status.type}`);
            console.error(`发送记录：${journal.eventPath}`);
            try {
                // DesktopClient.send 会丢弃回执，这里直接 call，便于人工查看返回结构。
                const result = await client.call<unknown>('send_message_to_thread', { threadId: taskId, hostId: 'local', prompt }, () => {
                    journal.event('manual_send_intent', { callerThreadId: client.callerThreadId, targetThreadId: taskId, prompt });
                    dispatched = true;
                });
                journal.event('manual_send_acknowledged', { targetThreadId: taskId, result });
                return result;
            } catch (error) {
                if (dispatched) {
                    journal.event('manual_send_uncertain', { targetThreadId: taskId, message: String(error) });
                    throw new Error(`发送结果不确定，请先查询目标会话核对，勿直接重发。记录：${journal.eventPath}`, { cause: error });
                }
                throw error;
            }
        } finally { release(); }
    });
}

const help = `Codex 核心数据手动验证（保持 Codex 桌面 App 打开并登录）
在 codex-resume 目录运行：
  node test/codex.test.ts quota
  node test/codex.test.ts tasks
  node test/codex.test.ts task <会话ID>
  node test/codex.test.ts launch <会话ID> --prompt "只回复：验证成功"
  node test/codex.test.ts launch <会话ID> --prompt-file <UTF-8提示词文件>
可选：--caller <调用会话ID> --pipe <命名管道路径>
默认从会话索引尾部发现调用会话，自动发现唯一桌面管道。
前三个命令只读；launch 是手动单次真实发送，不启动额度等待或自动托管。
输出为桌面返回的 JSON；可用 > result.json 保存。launch 的发送记录路径输出到 stderr。
不带命令显示帮助；导入本文件或运行 node --test 不连接真实桌面。`;

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true, options: {
            caller: { type: 'string' }, pipe: { type: 'string' },
            prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
        }
    });
    const [command = 'help', taskId] = positionals;
    if (command === 'help') { console.log(help); return; }
    if (!['quota', 'tasks', 'task', 'launch'].includes(command)) throw new Error(`未知命令：${command}\n${help}`);
    const needsTask = command === 'task' || command === 'launch';
    if (positionals.length !== (needsTask ? 2 : 1)) throw new Error(`命令参数不匹配\n${help}`);
    if (command !== 'launch' && (values.prompt !== undefined || values['prompt-file'] !== undefined)) {
        throw new Error('提示词参数仅用于 launch');
    }
    const options: ConnectionOptions = { callerThreadId: values.caller, pipe: values.pipe };
    let result: unknown;
    if (command === 'quota') result = await checkCodex(options);
    else if (command === 'tasks') result = await getTasks(options);
    else if (command === 'task') result = await getTaskById(taskId!, options);
    else {
        if ((values.prompt !== undefined) === (values['prompt-file'] !== undefined)) {
            throw new Error('launch 必须提供 --prompt 或 --prompt-file，且只能选择一个');
        }
        const prompt = values.prompt ?? readFileSync(resolve(values['prompt-file']!), 'utf8');
        result = await launchTask(taskId!, prompt, options);
    }
    console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main && !process.env.NODE_TEST_CONTEXT) {
    //   main().catch((error: unknown) => {
    //     console.error(error instanceof Error ? error.message : String(error));
    //     process.exitCode = 1;
    //   });


    // getTasks()
    //     .then((result) => {
    //         console.log('getTasks() succeeded', result);
    //     })
    //     .catch((error: unknown) => {
    //         console.error(error instanceof Error ? error.message : String(error));
    //         process.exitCode = 1;
    //     });


    getTaskById('01a1855a-8d81-7520-978e-e37cdcf49db1')
        .then((result) => {
            console.log('getTasks() succeeded', result);
            console.log('getTasks() succeeded', result.turns[0]?.items);
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}

