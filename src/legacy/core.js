import * as USites from './sites.js';
  'use strict';
  function url(value,base) {
    const u=new URL(value,base);
    if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw Error('仅支持普通 HTTP/HTTPS 网页地址。');
    if(base&&new URL(base).protocol==='https:'&&u.protocol==='http:'&&u.hostname===new URL(base).hostname)u.protocol='https:';
    u.hash='';return u.href;
  }
  const clean=s=>(s||'').replace(/\u00a0/g,' ').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\r/g,'').trim();
  const chapterPattern=/(?:第\s*[\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回话卷]|chapter\s+\d+)/i;
  function heading(value) {
    let title=clean(value),page=null,total=null;
    let m=title.match(/[（(]\s*第?\s*(\d+)\s*页\s*[/／]\s*共?\s*(\d+)\s*页?\s*[)）]\s*$/);
    if(!m)m=title.match(/[（(]\s*(\d+)\s*[/／]\s*(\d+)\s*[)）]\s*$/);
    if(m){page=+m[1];total=+m[2];title=title.slice(0,m.index);}
    title=title.replace(/[（(]\s*第?\s*\d+\s*页\s*[)）]\s*$/,'').trim();
    return {title,page,total};
  }
  function identity(value){return heading(value).title.replace(/\s+/g,'').replace(/[：:，,。.!！?？“”"'‘’《》【】\[\]（）()、_—-]/g,'').toLowerCase();}
  function sameTitle(a,b){return identity(a)===identity(b);}
  function allowed(value,base){
    const a=new URL(url(value)),b=new URL(url(base));
    if(a.origin===b.origin)return true;
    const site=USites.find(b.hostname);
    return !!site&&(a.hostname===site.domain||a.hostname.endsWith('.'+site.domain))&&!(b.protocol==='https:'&&a.protocol==='http:');
  }
  function ensureOrigin(value,origin){const normalized=url(value);if(!allowed(normalized,origin))throw Error('链接离开当前网站；请在目标网站重新识别。');return normalized;}
  function validate(job,index,record,data){
    const entry=job.catalog[index],origin=new URL(job.bookURL).origin;
    if(url(data.url)!==url(record.next))throw Error('响应页面地址与请求不一致。');
    if(data.kind!=='chapter'||!data.text||data.text.length<10)throw Error(`${entry.title}：正文未识别。请预览或填写正文选择器。`);
    if(data.text.includes('\ufffd')||/[\ue000-\uf8ff]/.test(data.text))throw Error(`${entry.title}：检测到编码异常或自定义字体，不能直接导出为正常文字。`);
    if(!sameTitle(data.title,entry.title))throw Error(`${entry.title}：正文标题“${data.title}”与目录不符，已停止以免混入其他章节。`);
    if(record.pages.some(p=>p.url===url(data.url)))throw Error('分页链接循环，已暂停。');
    if(record.pages.length>=100)throw Error('单章分页超过 100 页，请检查规则。');
    const h=heading(data.rawTitle||data.title);
    if(h.page!==null&&(h.page!==record.pages.length+1||h.total<h.page))throw Error('本章分页不连续，已暂停。');
    if(record.pages.length&&h.total!==null&&Number.isInteger(record.pages[0].total)&&record.pages[0].total!==h.total)throw Error('同章的总页数发生变化，已暂停。');
    const allowed=job.catalog.map(c=>c.url);
    let next=data.next?ensureOrigin(data.next,origin):null;
    const isCatalog=next&&(job.catalogURLs||[job.bookURL]).includes(next);
    const nextIndex=next?allowed.indexOf(next):-1;
    let done=false;
    if(h.total!==null&&h.page<h.total){
      if(!next||isCatalog||nextIndex>=0)throw Error('本章还有分页，但没有找到下一页，请检查下一页规则。');
    }else if(h.total!==null){
      done=true;
      if(next&&!isCatalog&&nextIndex!==index+1)throw Error('本章结束后的下一章不在目录预期位置，目录可能未收集完整。');
    }else if(nextIndex>=0){
      if(nextIndex!==index+1)throw Error('下一章链接回退或跳过目录章节，已暂停。');
      done=true;
    }else if(!next||isCatalog){done=true;}
    // Unknown next links are followed only within this chapter; the next response's title must match.
    if(!done&&record.pages.some(p=>p.url===next))throw Error('下一页链接形成循环。');
    return {done,next:done?null:next,page:record.pages.length+1,total:h.total,key:entry.url,title:entry.title};
  }
  function toTXT(job,records){
    let missing=[];const chunks=[job.title,`来源：${job.bookURL}`,`已保存 ${job.completed}/${job.catalog.length} 章，${job.pageCount} 页`,job.status==='complete'?'状态：已抓取识别目录全部章节':'状态：部分内容（尚有未完成章节）',''];
    for(let i=0;i<job.catalog.length;i++){
      const r=records.get(i);if(!r?.done)missing.push(job.catalog[i].title);
      if(!r?.pages.length)continue;
      chunks.push('',job.catalog[i].title,r.done?'':'【本章未完整】','');
      for(const p of r.pages)chunks.push(p.text,'');
    }
    if(missing.length)chunks.push('\r\n【未完成章节】',...missing);
    return '\ufeff'+chunks.join('\r\n');
  }
export {url,clean,chapterPattern,heading,identity,sameTitle,allowed,ensureOrigin,validate,toTXT};
