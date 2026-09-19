// 向聊天输入框投递内容（文本 / 页面元素 chip）的桥。
//
// 谁会用：浏览器面板的「选择元素」模式。用户在页面上点选一个元素后，面板把
// 生成的 CSS 选择器（附说明文字）投递到这里，TextInput 监听后追加进输入框并
// 聚焦 —— 用户接着补一句想做什么就能直接发送。与 lib/openPanel.ts 同一套路：
// 跨组件派发自定义事件，不靠 prop 层层传递。

export const INSERT_CHAT_TEXT_EVENT = 'cocode:insert-chat-text';

/** 向聊天输入框追加一段文本（保留原文，非空时另起一行）。 */
export function insertChatText(text: string) {
	window.dispatchEvent(new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail: { text } }));
}

/** 从浏览器面板「选择元素」投递来的页面元素引用。 */
export interface ElementRef {
	/** CSS 选择器（id 优先，否则 body 起的位置路径）。 */
	selector: string;
	/** 元素标签名（小写），如 img / button —— chip 上只显示这个。 */
	tag: string;
	/** 元素可见文字摘要（最多 60 字符），悬停展示。 */
	text: string;
}

export const INSERT_ELEMENT_REF_EVENT = 'cocode:insert-element-ref';

/** 向聊天输入框附加一个页面元素 chip（TextInput 渲染成小方框，发送时拼回文本）。 */
export function insertElementRef(ref: ElementRef) {
	window.dispatchEvent(new CustomEvent(INSERT_ELEMENT_REF_EVENT, { detail: ref }));
}
