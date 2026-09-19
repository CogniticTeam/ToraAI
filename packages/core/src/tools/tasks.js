// 结构化任务工具族：TaskCreate / TaskUpdate / TaskGet / TaskList。
//
// 让模型把多步工作拆成可追踪的任务，并在「计划」面板里实时可见 ——
// 用户不用盯着文字流猜进度，模型自己也有一条外置的工作清单可以对照。
//
// 存储不在本文件：任务属于**会话状态**（state.tasks_context），读写都经
// ctx.sessionState（桌面端由 bridge 接到会话存储 + state_updated SSE，
// 面板才可能实时刷新）。没有这个通道时（CLI 直跑、测试）如实说不可用，
// 不用内存假数据装成功 —— 那种"建了但看不见"的任务比没有更糟。

const STATES = ['pending', 'in_progress', 'completed'];

function unavailable() {
  return (
    '任务工具在当前运行里不可用：没有接通会话状态通道（桌面端会话才有）。' +
    '如果只是想让用户看到进度，可以直接在回复里分步说明。'
  );
}

function readTasks(ctx) {
  const st = ctx?.sessionState?.read?.();
  const tasks = st?.tasks_context?.tasks;
  return Array.isArray(tasks) ? tasks : null;
}

function writeTasks(ctx, tasks) {
  ctx?.sessionState?.write?.({ tasks_context: { tasks } });
}

function nextId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = /^T(\d+)$/.exec(String(t.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T${max + 1}`;
}

function findTask(tasks, id) {
  return tasks.find((t) => t.id === String(id ?? '').trim());
}

/** 沿 blocked_by 边从 start 出发能否绕回 start（环会让任务永远无法开工）。 */
function wouldCycle(tasks, startId, addEdgeTo) {
  const adj = new Map(tasks.map((t) => [t.id, t.blocked_by ?? []]));
  const list = adj.get(startId) ?? [];
  adj.set(startId, [...list, addEdgeTo]);
  const seen = new Set();
  const stack = [addEdgeTo];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === startId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

const taskLine = (t) =>
  `#${t.id} [${t.state}] ${t.subject}${t.owner ? `（owner: ${t.owner}）` : ''}`;

export const taskCreate = {
  name: 'TaskCreate',
  description:
    '创建一条任务，进入会话的「计划」面板（用户可见）。多步工作先拆任务再动手：' +
    '每完成一步用 TaskUpdate 更新状态，别攒到最后一次性补。',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: '一句话任务标题（祈使句，如「修复登录超时」）' },
      description: { type: 'string', description: '要做什么、做到什么程度算完成' },
      metadata: {
        type: 'object',
        description: '任意附加信息（键值对），可选',
        additionalProperties: true
      }
    },
    required: ['subject']
  },

  async execute(args, ctx = {}) {
    if (!ctx.sessionState?.write) return unavailable();
    const subject = String(args?.subject ?? '').trim();
    if (!subject) return 'TaskCreate 需要 subject。';

    const tasks = readTasks(ctx) ?? [];
    const task = {
      id: nextId(tasks),
      subject,
      description: String(args?.description ?? ''),
      metadata: args?.metadata && typeof args.metadata === 'object' ? args.metadata : {},
      created_at: new Date().toISOString(),
      state: 'pending',
      owner: null,
      blocks: [],
      blocked_by: []
    };
    writeTasks(ctx, [...tasks, task]);
    return `已创建 #${task.id}：${subject}（共 ${tasks.length + 1} 条任务）。`;
  }
};

export const taskUpdate = {
  name: 'TaskUpdate',
  description:
    '更新任务：改状态（pending / in_progress / completed）、标题、描述、owner 或依赖。' +
    '开工一条任务前置它为 in_progress，完成后置 completed —— 计划面板会实时反映。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 id，如 T2' },
      state: { type: 'string', enum: STATES, description: '新状态' },
      subject: { type: 'string', description: '新标题' },
      description: { type: 'string', description: '新描述' },
      owner: { type: 'string', description: '负责人（agent 名或 null）' },
      addBlockedBy: { type: 'array', items: { type: 'string' }, description: '追加「被哪些任务阻塞」' },
      metadata: { type: 'object', description: '合并进 metadata 的键值对', additionalProperties: true }
    },
    required: ['taskId']
  },

  async execute(args, ctx = {}) {
    if (!ctx.sessionState?.write) return unavailable();
    const tasks = readTasks(ctx) ?? [];
    const task = findTask(tasks, args?.taskId);
    if (!task) {
      const ids = tasks.map((t) => t.id).join('、') || '（暂无任务）';
      return `没有任务 ${args?.taskId}。现有：${ids}。`;
    }

    if (args?.state != null && !STATES.includes(args.state)) {
      return `非法状态 "${args.state}"。可用：${STATES.join(' / ')}。`;
    }
    const addBlockedBy = Array.isArray(args?.addBlockedBy) ? args.addBlockedBy.map(String) : [];
    for (const dep of addBlockedBy) {
      if (dep === task.id) return `不能让 #${task.id} 阻塞它自己。`;
      if (!findTask(tasks, dep)) return `依赖的任务 #${dep} 不存在。`;
      if (wouldCycle(tasks, task.id, dep)) {
        return `加上 #${task.id} ← #${dep} 会形成循环依赖，任务会永远无法开工 —— 请调整依赖方向。`;
      }
    }

    if (args?.state != null) task.state = args.state;
    if (typeof args?.subject === 'string' && args.subject.trim()) task.subject = args.subject.trim();
    if (typeof args?.description === 'string') task.description = args.description;
    if (args?.owner !== undefined) task.owner = args.owner == null ? null : String(args.owner);
    if (args?.metadata && typeof args.metadata === 'object') {
      task.metadata = { ...task.metadata, ...args.metadata };
    }
    for (const dep of addBlockedBy) {
      if (!task.blocked_by.includes(dep)) task.blocked_by.push(dep);
      // 对称写 blocks：被依赖方知道自己 block 了谁（面板据此显示 ← 阻塞关系）
      const other = findTask(tasks, dep);
      if (other && !other.blocks.includes(task.id)) other.blocks.push(task.id);
    }
    writeTasks(ctx, tasks);
    return `已更新 #${task.id}：${taskLine(task)}`;
  }
};

export const taskGet = {
  name: 'TaskGet',
  description: '查看一条任务的完整信息（描述、依赖、metadata）。',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'string', description: '任务 id，如 T2' } },
    required: ['taskId']
  },

  async execute(args, ctx = {}) {
    if (!ctx.sessionState?.read) return unavailable();
    const tasks = readTasks(ctx) ?? [];
    const task = findTask(tasks, args?.taskId);
    if (!task) {
      const ids = tasks.map((t) => t.id).join('、') || '（暂无任务）';
      return `没有任务 ${args?.taskId}。现有：${ids}。`;
    }
    return [
      `#${task.id} [${task.state}] ${task.subject}`,
      task.description || '（无描述）',
      task.owner ? `owner: ${task.owner}` : null,
      task.blocked_by.length ? `被阻塞于：${task.blocked_by.map((d) => `#${d}`).join('、')}` : null,
      task.blocks.length ? `阻塞着：${task.blocks.map((d) => `#${d}`).join('、')}` : null,
      Object.keys(task.metadata ?? {}).length
        ? `metadata: ${JSON.stringify(task.metadata)}`
        : null
    ].filter(Boolean).join('\n');
  }
};

export const taskList = {
  name: 'TaskList',
  description: '列出当前会话的全部任务（id、状态、标题）。想看某条的细节用 TaskGet。',
  parameters: { type: 'object', properties: {} },

  async execute(args, ctx = {}) {
    if (!ctx.sessionState?.read) return unavailable();
    const tasks = readTasks(ctx) ?? [];
    if (tasks.length === 0) return '当前没有任务。需要拆解多步工作时用 TaskCreate 建条目。';
    const done = tasks.filter((t) => t.state === 'completed').length;
    return [`共 ${tasks.length} 条（完成 ${done}）：`, ...tasks.map(taskLine)].join('\n');
  }
};

export const taskTools = [taskCreate, taskUpdate, taskGet, taskList];
