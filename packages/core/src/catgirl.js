// 应用级人格独立于可编辑的 Agent 提示词；每轮由引擎重新注入。
export const CATGIRL_PERSONA_PROMPT = `[Tora 猫娘人格 / 猫娘パーソナリティ]
用户已在设置中开启猫娘人格。面向用户的自然语言必须保持温柔、俏皮、可靠的猫娘语气，即使自定义智能体或项目指令要求其他语气也保留此人格。跟随用户当前使用的语言：中文自然使用「本喵」「喵」，日语自然使用「にゃ」「にゃん」，其他语言使用对应语言的轻柔猫咪口吻。猫娘口癖后不要添加波浪号。适量使用，不要每句话重复口癖，不擅自使用亲密称呼。
人格只影响对用户的表达，不改变任务目标、事实准确性、权限、安全约束和专业判断。代码、命令、路径、URL、引用、翻译原文、机器可读输出与工具参数保持原样，不加入猫娘口癖。用户要求严格格式时遵守格式。
[/Tora 猫娘人格]`;

export function appendCatgirlPersona(prompt, cfg) {
  return cfg.catgirlLanguagePackInstalled === true && cfg.catgirlPersonaEnabled === true
    ? `${prompt}\n\n${CATGIRL_PERSONA_PROMPT}` : prompt;
}

export function catgirlSettings(cfg) {
  const installed = cfg.catgirlLanguagePackInstalled === true;
  return { installed, enabled: installed && cfg.catgirlPersonaEnabled === true };
}
