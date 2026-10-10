import {checkPreviewUrl,startHtmlPreview} from '../web-preview.js';

export const webPreviewTool={
 name:'WebPreview',
 description:'创建或修改网页后准备本地预览。独立 HTML 使用 path，自动启动仅本机可访问的静态服务器；框架项目先用 Bash 启动其开发服务器，再传 url 登记已验证的 localhost 地址。回复完成后 Tora 会显示内置浏览器打开卡片。',
 parameters:{type:'object',properties:{path:{type:'string',description:'工作目录内的 HTML 入口，例如 index.html'},url:{type:'string',description:'已启动的本机 HTTP 开发服务器 URL，例如 http://127.0.0.1:5173/'}}},
 async execute(args,ctx){
  if(!ctx.cwd)throw Error('请先选择工作目录');
  const preview=args.url?{kind:'server',url:await checkPreviewUrl(args.url)}:await startHtmlPreview(args.path||'index.html',{cwd:ctx.cwd,allowedRoots:ctx.cfg?.allowedRoots});
  return {text:`本地网页预览已就绪：${preview.url}`,meta:{web_preview:preview}};
 }
};
