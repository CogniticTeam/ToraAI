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

export function hasTaskStateChannel(channel) {
  return typeof channel?.read === 'function' && typeof channel?.write === 'function';
}

function taskFailure(kind, text) {
  return { ok: false, text, meta: { failure: { kind, retryable: false } } };
}

function unavailable() {
  return taskFailure(
    'task_channel_unavailable',
    '任务工具在当前运行里不可用：没有接通会话状态通道（桌面端会话才有）。' +
    '如果只是想让用户看到进度，可以直接在回复里分步说明。'
  );
}

function readTasks(ctx) {
  const st = ctx.sessionState.read();
  const tasks = st?.tasks_context?.tasks;
  return Array.isArray(tasks) ? tasks : null;
}

function writeTasks(ctx, tasks) {
  ctx.sessionState.write({ tasks_context: { tasks } });
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
  requiresWorkspace: false,
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
    if (!hasTaskStateChannel(ctx?.sessionState)) return unavailable();
    const subject = typeof args?.subject === 'string' ? args.subject.trim() : '';
    if (!subject) return taskFailure('invalid_task_subject', 'TaskCreate 需要 subject。');

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
  requiresWorkspace: false,
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
      owner: { type: ['string', 'null'], description: '负责人（agent 名或 null）' },
      addBlockedBy: { type: 'array', items: { type: 'string' }, description: '追加「被哪些任务阻塞」' },
      metadata: { type: 'object', description: '合并进 metadata 的键值对', additionalProperties: true }
    },
    required: ['taskId']
  },

  async execute(args, ctx = {}) {
    if (!hasTaskStateChannel(ctx?.sessionState)) return unavailable();
    const records = readTasks(ctx) ?? [];
    const validId = typeof args?.taskId === 'string' && args.taskId.trim().length > 0;
    const originalTask = validId ? findTask(records, args.taskId) : null;
    if (!originalTask) {
      const ids = records.map((t) => t.id).join('、') || '（暂无任务）';
      return taskFailure(
        validId ? 'task_not_found' : 'invalid_task_id',
        `没有任务 ${args?.taskId}。现有：${ids}。`
      );
    }

    if (args?.state !== undefined && !STATES.includes(args.state)) {
      return taskFailure(
        'invalid_task_state',
        `非法状态 "${args.state}"。可用：${STATES.join(' / ')}。`
      );
    }
    if (args?.subject !== undefined &&
        (typeof args.subject !== 'string' || !args.subject.trim())) {
      return taskFailure('invalid_task_subject', 'TaskUpdate 的 subject 必须是非空字符串。');
    }
    if (args?.addBlockedBy !== undefined &&
        (!Array.isArray(args.addBlockedBy) ||
         args.addBlockedBy.some((dep) => typeof dep !== 'string' || !dep.trim()))) {
      return taskFailure('invalid_task_dependencies', 'addBlockedBy 需要是任务 id 的非空字符串数组。');
    }
    const addBlockedBy = [...new Set((args?.addBlockedBy ?? []).map((dep) => dep.trim()))];

    // read() 可能直接返回存储拥有的对象；所有改动只发生在候选副本中。
    const tasks = records.map((t) => ({
      ...t,
      blocked_by: [...(t.blocked_by ?? [])],
      blocks: [...(t.blocks ?? [])],
      metadata: { ...t.metadata }
    }));
    const task = findTask(tasks, originalTask.id);
    const newBlockedBy = addBlockedBy.filter((dep) => !task.blocked_by.includes(dep));
    for (const dep of addBlockedBy) {
      if (dep === task.id) {
        return taskFailure('task_dependency_self', `不能让 #${task.id} 阻塞它自己。`);
      }
      if (!findTask(tasks, dep)) {
        return taskFailure('task_dependency_not_found', `依赖的任务 #${dep} 不存在。`);
      }
      if (wouldCycle(tasks, task.id, dep)) {
        return taskFailure(
          'task_dependency_cycle',
          `加上 #${task.id} ← #${dep} 会形成循环依赖，任务会永远无法开工 —— 请调整依赖方向。`
        );
      }
    }

    if (args?.state !== undefined) task.state = args.state;
    if (typeof args?.subject === 'string') task.subject = args.subject.trim();
    if (typeof args?.description === 'string') task.description = args.description;
    if (args?.owner !== undefined) task.owner = args.owner == null ? null : String(args.owner);
    if (args?.metadata && typeof args.metadata === 'object') {
      task.metadata = { ...task.metadata, ...args.metadata };
    }
    if (addBlockedBy.length) {
      task.blocked_by = [...new Set([...task.blocked_by, ...addBlockedBy])];
    }
    for (const dep of addBlockedBy) {
      // 对称写 blocks：被依赖方知道自己 block 了谁（面板据此显示 ← 阻塞关系）
      const other = findTask(tasks, dep);
      other.blocks = [...new Set([...other.blocks, task.id])];
    }

    if (task.state === 'in_progress' || task.state === 'completed') {
      // 显式推进/重申状态要检查全部前置；仅追加依赖时只检查新边，不冻结历史不一致。
      const checkedDependencies = args?.state !== undefined ? task.blocked_by : newBlockedBy;
      const unfinished = [];
      for (const dep of new Set(checkedDependencies)) {
        const prerequisite = findTask(tasks, dep);
        if (!prerequisite) {
          return taskFailure('task_dependency_not_found', `依赖的任务 #${dep} 不存在。`);
        }
        if (prerequisite.state !== 'completed') unfinished.push(dep);
      }
      if (unfinished.length) {
        return taskFailure(
          'task_blocked',
          `任务 #${task.id} 的前置任务 ${unfinished.map((dep) => `#${dep}`).join('、')} 尚未完成，` +
          `不能进入或保持 ${task.state}。请先完成前置任务，或将此任务设为 pending。`
        );
      }
    }

    if (originalTask.state === 'completed' &&
        (task.state === 'pending' || task.state === 'in_progress')) {
      // blocked_by 才是依赖事实，不能依赖可能缺失或过时的反向 blocks 索引。
      const dependents = tasks.filter((other) =>
        (other.state === 'in_progress' || other.state === 'completed') &&
        other.blocked_by.includes(task.id)
      );
      if (dependents.length) {
        return taskFailure(
          'task_has_active_dependents',
          `不能重新打开 #${task.id}：依赖它的任务 ${dependents.map((other) => `#${other.id}`).join('、')}` +
          ' 仍为 in_progress 或 completed。请先将这些任务设为 pending。'
        );
      }
    }

    writeTasks(ctx, tasks);
    return `已更新 #${task.id}：${taskLine(task)}`;
  }
};

export const taskGet = {
  name: 'TaskGet',
  requiresWorkspace: false,
  description: '查看一条任务的完整信息（描述、依赖、metadata）。',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'string', description: '任务 id，如 T2' } },
    required: ['taskId']
  },

  async execute(args, ctx = {}) {
    if (typeof ctx?.sessionState?.read !== 'function') return unavailable();
    const tasks = readTasks(ctx) ?? [];
    const validId = typeof args?.taskId === 'string' && args.taskId.trim().length > 0;
    const task = validId ? findTask(tasks, args.taskId) : null;
    if (!task) {
      const ids = tasks.map((t) => t.id).join('、') || '（暂无任务）';
      return taskFailure(
        validId ? 'task_not_found' : 'invalid_task_id',
        `没有任务 ${args?.taskId}。现有：${ids}。`
      );
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
  requiresWorkspace: false,
  description: '列出当前会话的全部任务（id、状态、标题）。想看某条的细节用 TaskGet。',
  parameters: { type: 'object', properties: {} },

  async execute(args, ctx = {}) {
    if (typeof ctx?.sessionState?.read !== 'function') return unavailable();
    const tasks = readTasks(ctx) ?? [];
    if (tasks.length === 0) return '当前没有任务。需要拆解多步工作时用 TaskCreate 建条目。';
    const done = tasks.filter((t) => t.state === 'completed').length;
    return [`共 ${tasks.length} 条（完成 ${done}）：`, ...tasks.map(taskLine)].join('\n');
  }
};

export const taskTools = [taskCreate, taskUpdate, taskGet, taskList];
